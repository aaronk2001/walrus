import { Box, Text, useInput, useStdout } from "ink";
import { useRef } from "react";
import { useRefState } from "./useRefState";
import { useStore } from "zustand";
import {
  store,
  closeHub,
  setHubTab,
  setModel,
  startPull,
  toggleAgent,
  toggleSkill,
  toggleTool,
  toggleMcp,
  mcpTools,
  type HubTab,
} from "../store";
import { ALL_TOOLS } from "../agent/tools";
import { theme } from "../theme";
import { clip } from "../catalog";
import { applyEdit, type Edit } from "./Input";
import { bar } from "./Hud";

const TABS: HubTab[] = ["models", "skills", "agents", "tools", "mcp"];
const TAB_LABEL: Record<HubTab, string> = { models: "Models", skills: "Skills", agents: "Agents", tools: "Tools", mcp: "MCP" };
const WINDOW = 12;
const PULL_ROW = "__pull__";

// pad to width, clipping with an ellipsis so there is always a one-space gap
const fit = (s: string, w: number) => (s.length > w - 1 ? s.slice(0, w - 2) + "…" : s).padEnd(w);

export const fmtSize = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

interface Row {
  key: string;
  on: boolean;
  label: string;
  meta: string;
  desc: string;
  metaColor?: string;
}

function useRows(tab: HubTab): Row[] {
  const s = useStore(store);
  if (tab === "models") {
    const rows: Row[] = s.models.map((m) => ({
      key: m.name,
      on: m.name === s.cfg.model,
      label: m.name,
      meta: [m.params, m.quant, fmtSize(m.size)].filter(Boolean).join(" · "),
      desc: [
        m.caps?.includes("tools") ? "tools" : m.caps ? "no tools" : "",
        m.caps?.includes("thinking") ? "thinking" : "",
        m.caps?.includes("vision") ? "vision" : "",
        m.loaded ? "in VRAM" : "",
      ]
        .filter(Boolean)
        .join(" · "),
      metaColor: m.caps && !m.caps.includes("tools") ? theme.red : undefined,
    }));
    rows.push({ key: PULL_ROW, on: false, label: "+ Pull a model…", meta: "", desc: "download from ollama.com/library" });
    return rows;
  }
  if (tab === "skills")
    return s.skills.map((k) => ({ key: k.name, on: k.enabled, label: k.name, meta: k.source, desc: k.description }));
  if (tab === "agents")
    return s.agents.map((a) => ({
      key: a.name,
      on: a.enabled,
      label: a.name,
      meta: a.source + (a.model ? ` · ${a.model}` : ""),
      desc: a.description,
    }));
  if (tab === "mcp")
    return s.mcp.map((m) => ({
      key: m.spec.name,
      on: m.status === "on" || m.status === "connecting",
      label: m.spec.name,
      meta: `${m.spec.source} · ${m.spec.type}`,
      desc:
        m.status === "on"
          ? `connected · ${m.tools} tools`
          : m.status === "connecting"
            ? "connecting…"
            : m.status === "error"
              ? `error: ${m.error}`
              : (m.spec.url ?? [m.spec.command, ...(m.spec.args ?? [])].join(" ")),
      metaColor: m.status === "error" ? theme.red : undefined,
    }));
  const mcpRows = mcpTools().map((t) => ({
    key: t.name,
    on: s.cfg.tools[t.name] !== false,
    label: t.name.replace(/^mcp__/, "").replace("__", ":"),
    meta: t.mutates ? "asks first" : "read-only",
    desc: t.description,
  }));
  return [...ALL_TOOLS.map((t) => ({
    key: t.name,
    on: s.cfg.tools[t.name] !== false,
    label: t.name,
    meta: t.mutates ? "asks first" : "",
    desc: t.description,
  })), ...mcpRows];
}

export function Hub() {
  const tab = useStore(store, (s) => s.hubTab);
  const pull = useStore(store, (s) => s.pull);
  const ollamaError = useStore(store, (s) => s.ollamaError);
  const rows = useRows(tab);
  const { stdout } = useStdout();
  const width = Math.max(60, Math.min(stdout.columns ?? 100, 140) - 4);
  const [getFilter, setFilter] = useRefState("");
  const [getCursor, setCursor] = useRefState(0);
  const [getPull, setPullInput] = useRefState<Edit | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const visibleFor = (all: Row[], f: string) => {
    const q = f.toLowerCase();
    return q ? all.filter((r) => r.label.toLowerCase().includes(q) || r.desc.toLowerCase().includes(q)) : all;
  };
  const filter = getFilter();
  const pullInput = getPull();
  const visible = visibleFor(rows, filter);
  const cur = Math.min(getCursor(), Math.max(0, visible.length - 1));
  const start = Math.max(0, Math.min(cur - Math.floor(WINDOW / 2), visible.length - WINDOW));
  const shown = visible.slice(start, start + WINDOW);

  const switchTab = (dir: number) => {
    const t = store.getState().hubTab;
    setHubTab(TABS[(TABS.indexOf(t) + dir + TABS.length) % TABS.length]!);
    setFilter("");
    setCursor(0);
  };

  const activate = (row: Row | undefined, viaEnter: boolean) => {
    if (!row) return;
    const tab = store.getState().hubTab;
    if (tab === "models") {
      if (row.key === PULL_ROW) setPullInput({ value: "", cursor: 0 });
      else if (viaEnter || !row.on) setModel(row.key);
      return;
    }
    if (tab === "skills") toggleSkill(row.key);
    else if (tab === "agents") toggleAgent(row.key);
    else if (tab === "mcp") toggleMcp(row.key);
    else toggleTool(row.key);
  };

  useInput((input, key) => {
    const pullInput = getPull();
    const filter = getFilter();
    const visible = visibleFor(rowsRef.current, filter);
    const cur = Math.min(getCursor(), Math.max(0, visible.length - 1));
    if (pullInput) {
      if (key.escape) return setPullInput(null);
      if (key.return) {
        const name = pullInput.value.trim();
        setPullInput(null);
        if (name && !store.getState().pull) void startPull(name);
        return;
      }
      const n = applyEdit(pullInput, input, key);
      if (n) setPullInput(n);
      return;
    }
    if (key.escape) {
      if (filter) return setFilter("");
      return closeHub();
    }
    if (key.leftArrow || (key.tab && key.shift)) return switchTab(-1);
    if (key.rightArrow || key.tab) return switchTab(1);
    if (key.upArrow) return setCursor(Math.max(0, cur - 1));
    if (key.downArrow) return setCursor(Math.min(visible.length - 1, cur + 1));
    if (key.pageUp) return setCursor(Math.max(0, cur - WINDOW));
    if (key.pageDown) return setCursor(Math.min(visible.length - 1, cur + WINDOW));
    if (key.return) return activate(visible[cur], true);
    if (input === " ") return activate(visible[cur], false);
    if (key.backspace || key.delete) {
      setFilter((f) => f.slice(0, -1));
      return setCursor(0);
    }
    if (input && !key.ctrl && !key.meta && /^[\w.:/-]+$/.test(input)) {
      setFilter((f) => f + input);
      setCursor(0);
    }
  });

  const enabledCount = rows.filter((r) => r.on && r.key !== PULL_ROW).length;
  const labelW = Math.min(30, Math.max(12, ...rows.map((r) => r.label.length)) + 2);
  const metaW = Math.min(28, Math.max(0, ...rows.map((r) => r.meta.length)) + 2);
  const descW = Math.max(10, width - labelW - metaW - 8);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} width={width}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={theme.text}>
            Walrus Hub
          </Text>
          <Text color={theme.muted}>  </Text>
          {TABS.map((t) => (
            <Text key={t}>
              {t === tab ? (
                <Text backgroundColor={theme.accent} color="#020617" bold>
                  {` ${TAB_LABEL[t]} `}
                </Text>
              ) : (
                <Text color={theme.tertiary}>{` ${TAB_LABEL[t]} `}</Text>
              )}
              <Text> </Text>
            </Text>
          ))}
        </Text>
        <Text color={theme.muted}>
          {tab === "models" ? `${rows.length - 1} installed` : `${enabledCount}/${rows.length} on`}
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>filter: </Text>
        <Text color={filter ? theme.accentHover : theme.muted}>{filter || "type to search"}</Text>
      </Box>

      {tab === "models" && ollamaError && <Text color={theme.red}>{ollamaError}</Text>}

      <Box flexDirection="column" marginTop={1}>
        {start > 0 && <Text color={theme.muted}>  ↑ {start} more</Text>}
        {shown.map((r, i) => {
          const selected = start + i === cur;
          const mark = tab === "models" ? (r.key === PULL_ROW ? " " : r.on ? "●" : "○") : r.on ? "■" : "□";
          return (
            <Text key={r.key} wrap="truncate">
              <Text color={selected ? theme.accent : theme.muted}>{selected ? "› " : "  "}</Text>
              <Text color={r.on ? theme.accent : theme.muted}>{mark} </Text>
              <Text color={selected ? theme.text : r.on ? theme.secondary : theme.tertiary} bold={selected}>
                {fit(r.label, labelW)}
              </Text>
              <Text color={r.metaColor ?? theme.muted}>{fit(r.meta, metaW)}</Text>
              <Text color={selected ? theme.secondary : theme.muted}>{clip(r.desc, descW)}</Text>
            </Text>
          );
        })}
        {!visible.length && <Text color={theme.muted}>  nothing matches "{filter}"</Text>}
        {start + WINDOW < visible.length && <Text color={theme.muted}>  ↓ {visible.length - start - WINDOW} more</Text>}
      </Box>

      {pullInput && (
        <Box marginTop={1} borderStyle="round" borderColor={theme.cyan} paddingX={1}>
          <Text color={theme.cyan}>pull model: </Text>
          <Text>
            {pullInput.value}
            <Text inverse> </Text>
          </Text>
          <Text color={theme.muted}>  e.g. qwen3:4b, llama3.2:3b · enter to pull · esc cancel</Text>
        </Box>
      )}
      {pull && (
        <Box marginTop={1}>
          <Text color={theme.cyan}>
            ↓ {pull.model} {bar(pull.pct, 20)} {pull.pct}% <Text color={theme.muted}>{pull.status}</Text>
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={theme.muted}>
          ↑↓ move · {tab === "models" ? "enter use model" : "space/enter toggle"} · ←→ tabs · type to filter · esc close
        </Text>
      </Box>
    </Box>
  );
}
