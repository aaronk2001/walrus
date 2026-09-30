export interface CommandSpec {
  name: string;
  args?: string;
  description: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: "help", description: "Show commands and keys" },
  { name: "hub", description: "Open the hub: models, skills, agents, tools" },
  { name: "model", args: "[name]", description: "Switch model (no name opens the hub)" },
  { name: "models", description: "Hub: models tab" },
  { name: "skills", description: "Hub: skills tab" },
  { name: "agents", description: "Hub: agents tab" },
  { name: "tools", description: "Hub: tools tab" },
  { name: "mcp", description: "Hub: MCP servers tab" },
  { name: "resume", description: "Reopen a saved conversation" },
  { name: "opencode", args: "[models]", description: "Share models, MCP, agents, commands with OpenCode" },
  { name: "think", description: "Toggle model thinking (off = much faster on small models)" },
  { name: "mode", description: "Toggle ask/auto permission mode (also shift+tab)" },
  { name: "compact", description: "Summarize the conversation to free context" },
  { name: "clear", description: "Start a new conversation" },
  { name: "exit", description: "Quit Walrus" },
];

export function parseCommand(input: string): { name: string; args: string } | null {
  const m = input.trim().match(/^\/([\w:.-]+)\s*([\s\S]*)$/);
  return m ? { name: m[1]!.toLowerCase(), args: m[2]!.trim() } : null;
}

export interface Suggestion {
  name: string;
  hint: string;
  kind: "command" | "skill" | "user" | "file";
}

type Named = { name: string; description: string };

export function suggest(input: string, skills: Named[], userCommands: Named[] = []): Suggestion[] {
  if (!input.startsWith("/") || /\s/.test(input)) return [];
  const q = input.slice(1).toLowerCase();
  const cmds = COMMANDS.filter((c) => c.name.startsWith(q)).map(
    (c): Suggestion => ({ name: c.name, hint: c.description, kind: "command" }),
  );
  const user = userCommands
    .filter((c) => c.name.startsWith(q))
    .map((c): Suggestion => ({ name: c.name, hint: c.description, kind: "user" }));
  const sk = skills
    .filter((s) => s.name.toLowerCase().includes(q))
    .map((s): Suggestion => ({ name: s.name, hint: s.description, kind: "skill" }));
  return [...cmds, ...user, ...sk].slice(0, 6);
}
