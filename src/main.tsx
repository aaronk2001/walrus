#!/usr/bin/env bun
import { render } from "ink";
import { parseArgs } from "node:util";
import { App } from "./ui/App";
import { VERSION } from "./version";
import { store, init, applyFlags, capsMap, shutdown, mcpTools, syncOpenCode, describeSync } from "./store";
import { runTurn } from "./session";
import { renderPixels, WALRUS } from "./mascot";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    model: { type: "string", short: "m" },
    print: { type: "string", short: "p" },
    yolo: { type: "boolean" },
    continue: { type: "boolean", short: "c" },
    version: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.version) {
  console.log(`walrus ${VERSION}`);
  process.exit(0);
}

if (values.help) {
  console.log(
    [
      ...renderPixels(WALRUS),
      "",
      `walrus ${VERSION} — local agent CLI for Ollama`,
      "",
      "Usage:",
      "  walrus                 start interactive session",
      '  walrus "question"      start with a first prompt',
      '  walrus -p "question"   print mode: answer and exit',
      "  walrus -c              continue the last conversation in this folder",
      "  walrus opencode-sync   share models, MCP servers, agents and commands with OpenCode",
      "",
      "Options:",
      "  -m, --model <name>     Ollama model for this run (e.g. qwen3:1.7b)",
      "  -p, --print <prompt>   non-interactive; file edits, shell and web fetches are denied unless --yolo",
      "      --yolo             allow write_file/edit_file/bash/web_fetch without asking (this run only)",
      "  -v, --version",
      "",
      "Config: ~/.walrus/config.json · Skills: ~/.walrus/skills, ~/.claude/skills · Agents: ~/.walrus/agents, ~/.claude/agents",
    ].join("\n"),
  );
  process.exit(0);
}

if (values.yolo) applyFlags({ mode: "auto" });

if (positionals[0] === "opencode-sync") {
  await init();
  if (store.getState().ollamaError) {
    console.error(store.getState().ollamaError);
    process.exit(1);
  }
  console.log(describeSync(await syncOpenCode(positionals.slice(1))));
  process.exit(0);
}

if (values.print !== undefined) {
  await init({ model: values.model, waitForMcp: true });
  const s = store.getState();
  // init reports problems (Ollama down, unknown -m model) as transcript lines
  for (const item of s.items) if (item.kind === "info" || item.kind === "error") console.error(item.text);
  if (s.ollamaError || (values.model && s.cfg.model !== values.model)) process.exit(1);
  let failed = false;
  await runTurn(
    {
      cfg: s.cfg,
      cwd: s.cwd,
      skills: s.skills,
      agents: s.agents,
      caps: capsMap(),
      extraTools: mcpTools(),
      emit: (e) => {
        if (e.type === "answer" && !e.agent) process.stdout.write(e.text);
        if (e.type === "tool_start") process.stderr.write(`\x1b[2m⏺ ${e.agent ? `[${e.agent}] ` : ""}${e.tool}\x1b[0m\n`);
        if (e.type === "error") {
          failed = true;
          process.stderr.write(`error: ${e.message}\n`);
        }
      },
      askPermission: async () => (values.yolo ? "yes" : "no"),
    },
    [],
    values.print,
    new AbortController().signal,
  );
  process.stdout.write("\n");
  process.exit(failed ? 1 : 0);
}

const { waitUntilExit } = render(
  <App initialModel={values.model} initialPrompt={positionals.join(" ").trim()} continueLast={values.continue} />,
  { exitOnCtrlC: false },
);
await waitUntilExit();
await shutdown();
process.exit(0);
