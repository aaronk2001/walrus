import { Box, Text } from "ink";
import { useStore } from "zustand";
import { store } from "../store";
import { todoStore } from "../agent/tools/todo";
import { theme } from "../theme";

export function bar(pct: number, width = 10): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const Sep = () => <Text color={theme.muted}> │ </Text>;

export function Hud() {
  const cfg = useStore(store, (s) => s.cfg);
  const ctx = useStore(store, (s) => s.ctxTokens);
  const tool = useStore(store, (s) => s.currentTool);
  const agent = useStore(store, (s) => s.activeAgent);
  const skills = useStore(store, (s) => s.skills);
  const agents = useStore(store, (s) => s.agents);
  const ollamaError = useStore(store, (s) => s.ollamaError);
  const warming = useStore(store, (s) => s.warming);
  const busyWith = useStore(store, (s) => s.busyWith);
  const mcpOn = useStore(store, (s) => s.mcp.filter((m) => m.status === "on").length);
  const todos = useStore(todoStore, (s) => s.todos);

  const pct = Math.round((ctx / cfg.numCtx) * 100);
  const ctxColor = pct >= 85 ? theme.red : pct >= 60 ? theme.yellow : theme.accent;
  const done = todos.filter((t) => t.status === "completed").length;
  const doing = todos.find((t) => t.status === "in_progress");

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        {/* one Text so a narrow terminal cuts the end off instead of wrapping every segment */}
        <Text wrap="truncate-end">
          <Text color={theme.accent} bold>
            ▌walrus
          </Text>
          <Sep />
          <Text color={ollamaError ? theme.red : theme.text}>{cfg.model}</Text>
          {warming && <Text color={theme.yellow}> ◌ loading</Text>}
          {busyWith && <Text color={theme.yellow}> ⏳ Ollama busy: {busyWith}</Text>}
          {cfg.think && <Text color={theme.purple}> ✻ think</Text>}
          <Sep />
          <Text color={theme.tertiary}>ctx </Text>
          <Text color={ctxColor}>{bar(pct)}</Text>
          <Text color={theme.tertiary}>
            {" "}
            {pct}% {fmtK(ctx)}/{fmtK(cfg.numCtx)}
          </Text>
          {tool && (
            <>
              <Sep />
              <Text color={theme.yellow}>⚙ {tool.tool}</Text>
            </>
          )}
          {agent && (
            <>
              <Sep />
              <Text color={theme.purple}>◆ {agent}</Text>
            </>
          )}
          {todos.length > 0 && (
            <>
              <Sep />
              <Text color={done === todos.length ? theme.green : theme.cyan}>
                ☐ {done}/{todos.length}
              </Text>
            </>
          )}
          <Sep />
          <Text color={theme.tertiary}>
            {skills.filter((s) => s.enabled).length} skills · {agents.filter((a) => a.enabled).length} agents
            {mcpOn > 0 && ` · ${mcpOn} mcp`}
          </Text>
          <Sep />
          <Text color={cfg.mode === "auto" ? theme.yellow : theme.green}>
            {cfg.mode === "auto" ? "⏵⏵ auto" : "◇ ask"}
          </Text>
          <Text color={theme.muted}> (shift+tab)</Text>
        </Text>
      </Box>
      {doing && (
        <Box paddingX={1}>
          <Text color={theme.cyan}>  ↳ {doing.content}</Text>
        </Box>
      )}
    </Box>
  );
}
