import { join, basename } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { claudeHome, walrusHome } from "./config";
import { parseFrontmatter } from "./frontmatter";
import { opencodeDirs } from "./opencode";

export interface UserCommand {
  name: string;
  description: string;
  argHint: string;
  path: string;
  source: "walrus" | "claude" | "opencode";
}

// Markdown prompt templates, same format as Claude Code's ~/.claude/commands.
export function discoverCommands(cwd = process.cwd()): UserCommand[] {
  const out = new Map<string, UserCommand>();
  const roots: Array<[string, UserCommand["source"]]> = [
    [join(walrusHome(), "commands"), "walrus"],
    [join(claudeHome(), "commands"), "claude"],
    ...opencodeDirs("command", cwd).map((d): [string, UserCommand["source"]] => [d, "opencode"]),
  ];
  for (const [root, source] of roots) {
    if (!existsSync(root)) continue;
    for (const f of readdirSync(root)) {
      if (!f.endsWith(".md")) continue;
      const name = basename(f, ".md").toLowerCase();
      if (out.has(name)) continue;
      const path = join(root, f);
      const { data, body } = parseFrontmatter(readFileSync(path, "utf8"));
      out.set(name, {
        name,
        description: data.description || body.trim().split("\n")[0]!.slice(0, 80),
        argHint: data["argument-hint"] ?? "",
        path,
        source,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function expandCommand(cmd: UserCommand, args: string): string {
  const { body } = parseFrontmatter(readFileSync(cmd.path, "utf8"));
  const positional = args.split(/\s+/).filter(Boolean);
  let text = body.replaceAll("$ARGUMENTS", args).replace(/\$(\d)/g, (_, n: string) => positional[Number(n) - 1] ?? "");
  if (args && !body.includes("$ARGUMENTS") && !/\$\d/.test(body)) text += `\n\n${args}`;
  return text.trim();
}
