import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { store, interrupt, toggleMode, init, submit, continueLast, push, type Item } from "../store";
import { Banner } from "./Banner";
import { ItemView } from "./Transcript";
import { Live } from "./Live";
import { Input } from "./Input";
import { Permission } from "./Permission";
import { Hud } from "./Hud";
import { Hub } from "./Hub";
import { Resume } from "./Resume";
import { theme } from "../theme";

export function App(props: { skipInit?: boolean; initialModel?: string; initialPrompt?: string; continueLast?: boolean }) {
  const skipInit = props.skipInit ?? false;
  const { exit } = useApp();
  const items = useStore(store, (s) => s.items);
  const epoch = useStore(store, (s) => s.epoch);
  const view = useStore(store, (s) => s.view);
  const permission = useStore(store, (s) => s.permission);
  const running = useStore(store, (s) => s.running);
  const exitRequested = useStore(store, (s) => s.exitRequested);
  const [ready, setReady] = useState(skipInit);
  const [ctrlC, setCtrlC] = useState(false);
  const { stdout } = useStdout();
  // one column short of the terminal: a full-width line can trigger an auto-wrap that desyncs redraws
  const width = Math.max(40, (stdout.columns ?? 100) - 1);

  useEffect(() => {
    if (skipInit) return;
    void init({ model: props.initialModel }).then(() => {
      setReady(true);
      if (props.continueLast && !continueLast()) push({ kind: "info", text: "No earlier conversation in this folder." });
      if (props.initialPrompt) void submit(props.initialPrompt);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (exitRequested) exit();
  }, [exitRequested, exit]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (running) return interrupt();
      if (ctrlC) return exit();
      setCtrlC(true);
      setTimeout(() => setCtrlC(false), 1500);
      return;
    }
    if (key.tab && key.shift && view === "chat") return toggleMode();
    if (key.escape && running && !permission) interrupt();
  });

  // Banner is printed once; wait for init so it shows real model/skill counts.
  if (!ready) {
    return <Text color={theme.muted}>Waking the walrus…</Text>;
  }

  return (
    <Box flexDirection="column" width={width}>
      <Static key={epoch} items={items}>
        {(item: Item) => (item.kind === "banner" ? <BannerNow key={item.id} /> : <ItemView key={item.id} item={item} />)}
      </Static>
      {view === "hub" ? (
        <Hub />
      ) : view === "resume" ? (
        <Resume />
      ) : (
        <>
          <Live />
          {permission ? <Permission req={permission} /> : <Input />}
        </>
      )}
      <Hud />
      {ctrlC && <Text color={theme.yellow}>Press ctrl+c again to quit</Text>}
    </Box>
  );
}

function BannerNow() {
  const s = store.getState();
  return (
    <Banner
      model={s.cfg.model}
      cwd={s.cwd}
      skills={s.skills.filter((k) => k.enabled).length}
      agents={s.agents.filter((a) => a.enabled).length}
      ollamaOk={!s.ollamaError}
    />
  );
}
