import { Box, Text } from "ink";
import type { Item } from "../store";
import { theme } from "../theme";
import { Markdown } from "./Markdown";
import { clip } from "../catalog";
import { isAbsolute, relative } from "node:path";
import { tildify } from "./Banner";

// attachments are stored as absolute paths; show them the way the user typed them
export function shortPath(file: string, cwd = process.cwd()) {
  const rel = relative(cwd, file);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll("\\", "/") : tildify(file);
}

const KEY_ARG: Record<string, string> = {
  read_file: "path",
  write_file: "path",
  edit_file: "path",
  list_dir: "path",
  grep: "pattern",
  bash: "cmd",
  web_fetch: "url",
  web_search: "query",
  skill: "name",
  agent: "name",
};

export function toolLabel(tool: string, input: Record<string, unknown>): string {
  const mcp = tool.match(/^mcp__(.+?)__(.+)$/);
  if (mcp) {
    const first = Object.values(input).find((v) => typeof v === "string");
    return `${mcp[1]}:${mcp[2]}(${clip(String(first ?? ""), 60)})`;
  }
  const key = KEY_ARG[tool];
  let arg = key && input[key] != null ? String(input[key]) : "";
  if (tool === "list_dir" && input.pattern) arg = `${arg || "."} ${input.pattern}`;
  if (tool === "agent" && input.task) arg = `${arg}: ${input.task}`;
  if (tool === "todo_write" && Array.isArray(input.todos)) arg = `${input.todos.length} items`;
  return `${tool}(${clip(arg, 70)})`;
}

export function resultPreview(tool: string, result: string): string {
  const lines = result.trimEnd().split("\n");
  if (tool === "read_file") return `Read ${lines.length} lines`;
  const first = clip(lines[0] ?? "", 100);
  return lines.length > 1 ? `${first}  (+${lines.length - 1} lines)` : first || "(no output)";
}

const DIFF_LINES = 12;

// Red/green preview of what an edit or write changed.
export function Diff({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  const lines: Array<[string, string]> = [];
  const split = (v: unknown) => String(v ?? "").split(/\r?\n/);
  if (tool === "edit_file") {
    for (const l of split(input.old)) lines.push(["-", l]);
    for (const l of split(input.new)) lines.push(["+", l]);
  } else if (tool === "write_file") {
    for (const l of split(input.content)) lines.push(["+", l]);
  }
  if (!lines.length) return null;
  const shown = lines.slice(0, DIFF_LINES);
  return (
    <Box flexDirection="column" marginLeft={4}>
      {shown.map(([sign, l], i) => (
        <Text key={i} color={sign === "-" ? theme.red : theme.green} backgroundColor={sign === "-" ? "#2a0f14" : "#0d2616"}>
          {sign} {clip(l, 110) || " "}
        </Text>
      ))}
      {lines.length > DIFF_LINES && <Text color={theme.muted}>  … {lines.length - DIFF_LINES} more lines</Text>}
    </Box>
  );
}

function AgentTag({ agent }: { agent?: string }) {
  return agent ? <Text color={theme.purple}>[{agent}] </Text> : null;
}

export function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box>
            <Box flexShrink={0}>
              <Text color={theme.accent}>› </Text>
            </Box>
            <Text color={theme.secondary}>{item.text}</Text>
          </Box>
          {item.files?.map((f) => (
            <Text key={f} color={theme.cyan}>
              {"  ⎘ "}
              {shortPath(f)}
            </Text>
          ))}
        </Box>
      );
    case "skills":
      return (
        <Box marginTop={-1} marginBottom={1}>
          <Text color={theme.muted}>
            {"  ◇ "}
            {item.routed ? "skills matched: " : "skills: "}
            <Text color={theme.purple}>{item.names.join(", ")}</Text>
          </Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginBottom={1} marginLeft={item.agent ? 2 : 0}>
          <Box flexShrink={0}>
            <Text color={theme.text}>⏺ </Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {item.agent && <AgentTag agent={item.agent} />}
            <Markdown text={item.text} />
          </Box>
        </Box>
      );
    case "tool":
      return (
        <Box flexDirection="column" marginBottom={1} marginLeft={item.agent ? 2 : 0}>
          <Text>
            <Text color={item.ok ? theme.green : theme.red}>⏺ </Text>
            <AgentTag agent={item.agent} />
            <Text bold>{toolLabel(item.tool, item.input)}</Text>
          </Text>
          <Text color={item.ok ? theme.tertiary : theme.red}>
            {"  ⎿ "}
            {item.tool === "agent" && item.ok ? "report received" : resultPreview(item.tool, item.result)}
          </Text>
          {item.ok && <Diff tool={item.tool} input={item.input} />}
          {item.tool === "agent" && item.ok && (
            <Box marginLeft={4}>
              <Markdown text={item.result} />
            </Box>
          )}
        </Box>
      );
    case "info":
      return (
        <Box marginBottom={1}>
          <Text color={theme.tertiary}>{item.text}</Text>
        </Box>
      );
    case "error":
      return (
        <Box marginBottom={1}>
          <Text color={theme.red}>✗ {item.text}</Text>
        </Box>
      );
    default:
      return null;
  }
}
