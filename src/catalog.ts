import { join, basename } from "node:path";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { parseFrontmatter } from "./frontmatter";
import { homedir } from "node:os";
import { claudeHome, walrusHome, type Config } from "./config";
import { opencodeDirs } from "./opencode";

export type Source = "walrus" | "claude" | "extra" | "opencode";

export interface Skill {
  name: string;
  description: string;
  path: string;
  source: Source;
  enabled: boolean;
}

export interface Agent {
  name: string;
  description: string;
  path: string;
  source: Source;
  tools: string[] | null;
  model: string | null;
  enabled: boolean;
}

function claudeSkillOverrides(): Record<string, string> {
  try {
    const s = JSON.parse(readFileSync(join(claudeHome(), "settings.json"), "utf8"));
    return s.skillOverrides ?? {};
  } catch {
    return {};
  }
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((d) => join(dir, d))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

export function discoverSkills(cfg: Config, cwd = process.cwd()): Skill[] {
  const overrides = claudeSkillOverrides();
  const roots: Array<[string, Source]> = [
    [join(walrusHome(), "skills"), "walrus"],
    [join(claudeHome(), "skills"), "claude"],
    ...cfg.skillDirs.map((d): [string, Source] => [d, "extra"]),
    ...opencodeDirs("skill", cwd).map((d): [string, Source] => [d, "opencode"]),
    [process.env.AGENTS_SKILLS_DIR ?? join(homedir(), ".agents", "skills"), "opencode"],
  ];
  const seen = new Set<string>();
  const out: Skill[] = [];
  for (const [root, source] of roots) {
    for (const dir of subdirs(root)) {
      const path = join(dir, "SKILL.md");
      if (!existsSync(path)) continue;
      const { data } = parseFrontmatter(readFileSync(path, "utf8"));
      // folder name is the id, as in Claude Code (/<skill> and skillOverrides use it)
      const name = basename(dir);
      if (seen.has(name)) continue;
      seen.add(name);
      const fallback = source !== "claude" || overrides[name] !== "off";
      out.push({
        name,
        description: data.description ?? "",
        path,
        source,
        enabled: cfg.skills[name] ?? fallback,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Claude Code tool names -> Walrus tool names
const TOOL_MAP: Record<string, string[]> = {
  Read: ["read_file"],
  Write: ["write_file"],
  Edit: ["edit_file"],
  MultiEdit: ["edit_file"],
  Bash: ["bash"],
  Glob: ["list_dir"],
  Grep: ["grep"],
  LS: ["list_dir"],
  WebFetch: ["web_fetch"],
  WebSearch: ["web_search"],
  TodoWrite: ["todo_write"],
};

export function mapAgentTools(spec: string | undefined): string[] | null {
  if (!spec || spec.trim() === "*") return null;
  const names = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const mapped = new Set<string>();
  for (const n of names) for (const t of TOOL_MAP[n] ?? [n]) mapped.add(t);
  return [...mapped];
}

export function discoverAgents(cfg: Config, installedModels: string[] = [], cwd = process.cwd()): Agent[] {
  const roots: Array<[string, Source]> = [
    [join(walrusHome(), "agents"), "walrus"],
    [join(claudeHome(), "agents"), "claude"],
    ...opencodeDirs("agent", cwd).map((d): [string, Source] => [d, "opencode"]),
  ];
  const seen = new Set<string>();
  const out: Agent[] = [];
  for (const [root, source] of roots) {
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root)) {
      if (!file.endsWith(".md")) continue;
      const path = join(root, file);
      const { data } = parseFrontmatter(readFileSync(path, "utf8"));
      const name = data.name || file.slice(0, -3);
      if (seen.has(name)) continue;
      seen.add(name);
      const model = data.model && installedModels.includes(data.model) ? data.model : null;
      out.push({
        name,
        description: data.description ?? "",
        path,
        source,
        tools: mapAgentTools(data.tools),
        model,
        enabled: cfg.agents[name] ?? true,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readBody(path: string): string {
  return parseFrontmatter(readFileSync(path, "utf8")).body.trim();
}

export const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};
