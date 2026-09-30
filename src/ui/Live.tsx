import { Box, Text, useStdout } from "ink";
import { useStore } from "zustand";
import { store } from "../store";
import { theme } from "../theme";
import { Markdown } from "./Markdown";
import { Spinner } from "./Spinner";
import { Buddy } from "./Buddy";
import { toolLabel } from "./Transcript";

// Rows the screen needs besides the streamed text: "more lines" note, tool line, spinner,
// margins, input box, HUD with its todo line, ctrl+c hint.
const CHROME_ROWS = 14;

// Once Ink's live area is as tall as the terminal, Ink clears the screen and reprints the whole
// transcript on every frame. So a streaming answer shows only the tail that fits; the full
// answer goes to the transcript when it finishes.
export function tailToFit(text: string, rows: number, width: number): { text: string; hidden: number } {
  const lines = text.split("\n");
  let start = lines.length;
  for (let used = 0; start > 0; start--) {
    used += Math.max(1, Math.ceil(lines[start - 1]!.length / width));
    if (used > rows) break;
  }
  if (!start) return { text, hidden: 0 };
  const shown = lines.slice(start);
  if (!shown.length) {
    // the last line alone is taller than the space: show its end
    start--;
    shown.push("…" + lines[start]!.slice(1 - rows * width));
  }
  // reopen a code block whose opening fence scrolled away
  const inCode = lines.slice(0, start).filter((l) => l.trimStart().startsWith("```")).length % 2 === 1;
  return { text: (inCode ? "```\n" : "") + shown.join("\n"), hidden: start };
}

export function Live() {
  const running = useStore(store, (s) => s.running);
  const live = useStore(store, (s) => s.live);
  const thinking = useStore(store, (s) => s.thinking);
  const tool = useStore(store, (s) => s.currentTool);
  const permission = useStore(store, (s) => s.permission);
  const warming = useStore(store, (s) => s.warming);
  const busyWith = useStore(store, (s) => s.busyWith);
  const { stdout } = useStdout();
  if (!running) return null;
  const lastThought = thinking.replace(/\s+/g, " ").trim().slice(-90);
  const waiting = !live.trim() && !tool && (!!warming || !!busyWith);
  const label = tool
    ? tool.tool === "agent"
      ? `Subagent ${tool.input.name} working…`
      : `Running ${tool.tool}…`
    : busyWith && !live
      ? `Waiting — Ollama is busy with ${busyWith}…`
      : warming && !live
        ? `Loading ${warming} into memory…`
        : undefined;
  const preview = tailToFit(
    live.trimStart(),
    Math.max(3, (stdout.rows || Infinity) - CHROME_ROWS),
    Math.max(20, (stdout.columns || 80) - 6),
  );
  return (
    <Box flexDirection="column" marginBottom={1}>
      {live.trim() && (
        <>
          {preview.hidden > 0 && <Text color={theme.muted}>  ↑ {preview.hidden} more lines</Text>}
          <Box marginBottom={1}>
            <Box flexShrink={0}>
              <Text>⏺ </Text>
            </Box>
            <Markdown text={preview.text} />
          </Box>
        </>
      )}
      {tool && (
        <Text>
          <Text color={theme.yellow}>⏺ </Text>
          {tool.agent && <Text color={theme.purple}>[{tool.agent}] </Text>}
          <Text bold>{toolLabel(tool.tool, tool.input)}</Text>
        </Text>
      )}
      {!permission && (
        <Box>
          <Buddy state={waiting ? "waiting" : tool ? "tool" : "working"} />
          <Box flexDirection="column" justifyContent="center">
            {lastThought && !live.trim() && (
              <Text color={theme.muted} italic wrap="truncate">
                {lastThought}
              </Text>
            )}
            <Spinner label={label} />
          </Box>
        </Box>
      )}
    </Box>
  );
}
