import { Box, Text, useInput } from "ink";
import { useEffect, useRef } from "react";
import { answerPermission, type PermissionRequest } from "../store";
import { theme } from "../theme";
import { clip } from "../catalog";

function Detail({ req }: { req: PermissionRequest }) {
  const { tool, input } = req;
  if (tool.name === "bash") return <Text color={theme.text}>$ {String(input.cmd ?? "")}</Text>;
  // in full: data sent out would be in the query string
  if (tool.name === "web_fetch") return <Text color={theme.text}>GET {String(input.url ?? "")}</Text>;
  if (tool.name === "write_file") {
    const lines = String(input.content ?? "").split("\n");
    return (
      <Box flexDirection="column">
        <Text color={theme.text}>{String(input.path)} ({lines.length} lines)</Text>
        {lines.slice(0, 6).map((l, i) => (
          <Text key={i} color={theme.green}>
            + {clip(l, 100) || " "}
          </Text>
        ))}
        {lines.length > 6 && <Text color={theme.muted}>  …</Text>}
      </Box>
    );
  }
  if (tool.name === "edit_file") {
    return (
      <Box flexDirection="column">
        <Text color={theme.text}>{String(input.path)}</Text>
        {String(input.old ?? "").split("\n").slice(0, 5).map((l, i) => (
          <Text key={`o${i}`} color={theme.red}>
            - {clip(l, 100) || " "}
          </Text>
        ))}
        {String(input.new ?? "").split("\n").slice(0, 5).map((l, i) => (
          <Text key={`n${i}`} color={theme.green}>
            + {clip(l, 100) || " "}
          </Text>
        ))}
      </Box>
    );
  }
  return <Text>{clip(JSON.stringify(input), 200)}</Text>;
}

// You can type while the model works, so keys that arrive right as the prompt appears belong to
// that message, not to the prompt (an "a" from "and" would allow the tool for the whole session).
export const PROMPT_GRACE_MS = 500;

export function Permission({ req }: { req: PermissionRequest }) {
  const readyAt = useRef(Date.now() + PROMPT_GRACE_MS);
  useEffect(() => {
    readyAt.current = Date.now() + PROMPT_GRACE_MS;
  }, [req]);
  useInput((input, key) => {
    if (Date.now() < readyAt.current) return;
    const c = input.toLowerCase();
    if (c === "y" || key.return) answerPermission("yes");
    else if (c === "a") answerPermission("always");
    else if (c === "n" || key.escape) answerPermission("no");
  });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.yellow} paddingX={1}>
      <Text bold color={theme.yellow}>
        {req.agent ? `[${req.agent}] ` : ""}Allow {req.tool.name}?
      </Text>
      <Box marginY={1} flexDirection="column">
        <Detail req={req} />
      </Box>
      <Text>
        <Text color={theme.green} bold>y</Text>
        <Text color={theme.tertiary}> yes · </Text>
        <Text color={theme.accent} bold>a</Text>
        <Text color={theme.tertiary}>
          {" "}
          always allow {req.tool.name}
          {req.tool.scope ? ` for ${req.tool.scope(req.input)}` : ""} this session ·{" "}
        </Text>
        <Text color={theme.red} bold>n</Text>
        <Text color={theme.tertiary}> no</Text>
      </Text>
    </Box>
  );
}
