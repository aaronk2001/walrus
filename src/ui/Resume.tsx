import { Box, Text, useInput } from "ink";
import { useStore } from "zustand";
import { store, resumeSession, closeResume } from "../store";
import { timeAgo } from "../sessions";
import { tildify } from "./Banner";
import { clip } from "../catalog";
import { theme } from "../theme";
import { useRefState } from "./useRefState";

const WINDOW = 10;

export function Resume() {
  const sessions = useStore(store, (s) => s.sessions);
  const cwd = useStore(store, (s) => s.cwd);
  const [getCursor, setCursor] = useRefState(0);
  const cur = Math.min(getCursor(), sessions.length - 1);
  const start = Math.max(0, Math.min(cur - Math.floor(WINDOW / 2), sessions.length - WINDOW));
  const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();

  useInput((_, key) => {
    const c = Math.min(getCursor(), sessions.length - 1);
    if (key.escape) return closeResume();
    if (key.upArrow) return setCursor(Math.max(0, c - 1));
    if (key.downArrow) return setCursor(Math.min(sessions.length - 1, c + 1));
    if (key.return && sessions[c]) resumeSession(sessions[c].id);
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold color={theme.text}>
        Resume a conversation
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {sessions.slice(start, start + WINDOW).map((s, i) => {
          const selected = start + i === cur;
          const here = norm(s.cwd) === norm(cwd);
          return (
            <Text key={s.id} wrap="truncate">
              <Text color={selected ? theme.accent : theme.muted}>{selected ? "› " : "  "}</Text>
              <Text color={selected ? theme.text : theme.secondary} bold={selected}>
                {clip(s.title.replace(/\s+/g, " "), 60).padEnd(62)}
              </Text>
              <Text color={theme.muted}>
                {timeAgo(s.updated).padEnd(10)} {String(s.turns).padStart(3)} turns · {s.model}
                {here ? "" : ` · ${tildify(s.cwd)}`}
              </Text>
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>↑↓ move · enter resume · esc cancel</Text>
      </Box>
    </Box>
  );
}
