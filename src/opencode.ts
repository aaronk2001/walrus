import { join, basename } from "node:path";
import { homedir } from "node:os";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { walrusHome } from "./config";
import { readBody, type Agent, type Skill } from "./catalog";
import type { UserCommand } from "./userCommands";
import type { ServerSpec } from "./mcp";

export const opencodeHome = () => process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");

// Strips // and /* */ comments and trailing commas, leaving string contents alone.
export function parseJsonc(text: string): unknown {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function configFile(dir: string): string | null {
  for (const f of ["opencode.json", "opencode.jsonc"]) if (existsSync(join(dir, f))) return join(dir, f);
  return null;
}

export function readConfig(dir: string): Record<string, unknown> | null {
  const f = configFile(dir);
  if (!f) return null;
  try {
    return parseJsonc(readFileSync(f, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Global dir first, then the project's .opencode; both singular and plural folder names are valid.
export function opencodeDirs(kind: "agent" | "command" | "skill", cwd: string): string[] {
  return [opencodeHome(), join(cwd, ".opencode")].flatMap((d) => [join(d, kind), join(d, `${kind}s`)]);
}

type OcMcp = {
  type?: "local" | "remote";
  command?: string[];
  environment?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
};

const envToClaude = (s: string) => s.replace(/\{env:(\w+)\}/g, "${$1}");
const envToOpencode = (s: string) => s.replace(/\$\{(\w+)(?::-[^}]*)?\}/g, "{env:$1}");
const mapValues = (o: Record<string, string> | undefined, f: (s: string) => string) =>
  o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(String(v))])) : undefined;

// OpenCode MCP entries converted to the Claude/.mcp.json shape Walrus already understands.
export function opencodeMcpServers(cwd: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const conf of [readConfig(join(cwd, ".opencode")), readConfig(cwd), readConfig(opencodeHome())]) {
    for (const [name, m] of Object.entries((conf?.mcp ?? {}) as Record<string, OcMcp>)) {
      if (name in out) continue;
      if (m.type === "remote" && m.url)
        out[name] = { type: "http", url: envToClaude(m.url), headers: mapValues(m.headers, envToClaude) };
      else if (m.command?.length)
        out[name] = {
          type: "stdio",
          command: envToClaude(m.command[0]!),
          args: m.command.slice(1).map(envToClaude),
          env: mapValues(m.environment, envToClaude),
        };
    }
  }
  return out;
}

// ---- sync Walrus setup into OpenCode ----

interface Manifest {
  files: string[];
  mcp: string[];
}

const manifestPath = () => join(walrusHome(), "opencode-sync.json");
function loadManifest(): Manifest {
  try {
    return JSON.parse(readFileSync(manifestPath(), "utf8"));
  } catch {
    return { files: [], mcp: [] };
  }
}

export const PROVIDER_ID = "walrus";
export const VARIANT_CTX = 16384;
export const variantName = (base: string) => `${base.includes(":") ? base : `${base}:latest`}-16k`;

const yamlStr = (s: string) => JSON.stringify(s.replace(/\s+/g, " ").trim());

export function agentMarkdown(a: Agent): string {
  const lines = ["---", `description: ${yamlStr(a.description || a.name)}`, "mode: subagent"];
  if (a.tools) {
    const has = (t: string) => a.tools!.includes(t);
    lines.push(
      "permission:",
      `  edit: ${has("edit_file") || has("write_file") ? "ask" : "deny"}`,
      `  bash: ${has("bash") ? "ask" : "deny"}`,
      `  webfetch: ${has("web_fetch") ? "allow" : "deny"}`,
    );
  }
  lines.push("---", "", readBody(a.path), "");
  return lines.join("\n");
}

export function commandMarkdown(c: UserCommand): string {
  return ["---", `description: ${yamlStr(c.description || c.name)}`, "---", "", readBody(c.path), ""].join("\n");
}

export function mcpEntry(spec: ServerSpec, enabled: boolean): OcMcp {
  const raw = spec.raw ?? {};
  if (spec.type === "http")
    return { type: "remote", url: envToOpencode(raw.url ?? spec.url!), headers: mapValues(raw.headers, envToOpencode), enabled };
  const env = mapValues(raw.env, envToOpencode);
  return {
    type: "local",
    command: [raw.command ?? spec.command!, ...(raw.args ?? spec.args ?? [])].map(envToOpencode),
    ...(env && Object.keys(env).length ? { environment: env } : {}),
    enabled,
  };
}

export interface SyncInput {
  ollamaHost: string;
  models: string[]; // Ollama model names to expose (16k variants)
  servers: ServerSpec[];
  mcpEnabled: Record<string, boolean>;
  agents: Agent[];
  commands: UserCommand[];
  skills: Skill[];
}

export interface SyncResult {
  configPath: string;
  models: string[];
  mcp: string[];
  agents: string[];
  commands: string[];
  skills: string[];
  skipped: string[]; // user's own files/entries left untouched
}

export function syncToOpenCode(input: SyncInput): SyncResult {
  const home = opencodeHome();
  mkdirSync(home, { recursive: true });
  const prev = loadManifest();
  const owned = new Set(prev.files);
  const next: Manifest = { files: [], mcp: [] };
  const result: SyncResult = { configPath: "", models: [], mcp: [], agents: [], commands: [], skills: [], skipped: [] };

  // opencode.json: our provider + MCP entries, everything else preserved
  const existingPath = configFile(home);
  const conf = (readConfig(home) ?? { $schema: "https://opencode.ai/config.json" }) as Record<string, any>;
  if (existingPath?.endsWith(".jsonc")) cpSync(existingPath, `${existingPath}.walrus-backup`);
  conf.provider ??= {};
  conf.provider[PROVIDER_ID] = {
    npm: "@ai-sdk/openai-compatible",
    name: "Ollama (local, via Walrus)",
    options: { baseURL: `${input.ollamaHost.replace(/\/$/, "")}/v1`, timeout: 600_000, chunkTimeout: 600_000 }, // 2.0.x rejects `false`; 10 min covers slow local loads
    models: Object.fromEntries(
      input.models.map((m) => [variantName(m), { name: `${m} · 16k local`, limit: { context: VARIANT_CTX, output: 4096 } }]),
    ),
  };
  result.models = input.models.map(variantName);

  conf.mcp ??= {};
  for (const spec of input.servers) {
    if (spec.source === "opencode") continue;
    if (spec.name in conf.mcp && !prev.mcp.includes(spec.name)) {
      result.skipped.push(`mcp:${spec.name}`);
      continue;
    }
    conf.mcp[spec.name] = mcpEntry(spec, !!input.mcpEnabled[spec.name]);
    next.mcp.push(spec.name);
    result.mcp.push(spec.name);
  }
  for (const name of prev.mcp) if (!next.mcp.includes(name)) delete conf.mcp[name];

  const configPath = existingPath ?? join(home, "opencode.json");
  writeFileSync(configPath, JSON.stringify(conf, null, 2) + "\n");
  result.configPath = configPath;

  const writeOwned = (path: string, text: string, label: string, bucket: string[]) => {
    if (existsSync(path) && !owned.has(path)) {
      result.skipped.push(label);
      return;
    }
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    next.files.push(path);
    bucket.push(label);
  };

  for (const a of input.agents)
    if (a.enabled && a.source !== "opencode") writeOwned(join(home, "agents", `${a.name}.md`), agentMarkdown(a), a.name, result.agents);
  for (const c of input.commands)
    if (c.source !== "opencode") writeOwned(join(home, "commands", `${c.name}.md`), commandMarkdown(c), c.name, result.commands);

  // OpenCode reads ~/.claude/skills itself; copy only skills it can't see.
  for (const s of input.skills) {
    if (!s.enabled || s.source === "claude" || s.source === "opencode") continue;
    const dest = join(home, "skills", s.name);
    const marker = join(dest, "SKILL.md");
    if (existsSync(marker) && !owned.has(marker)) {
      result.skipped.push(s.name);
      continue;
    }
    cpSync(join(s.path, ".."), dest, { recursive: true });
    next.files.push(marker);
    result.skills.push(s.name);
  }

  // remove files from earlier syncs that are no longer produced
  for (const f of prev.files) {
    if (next.files.includes(f) || !existsSync(f)) continue;
    if (basename(f) === "SKILL.md") rmSync(join(f, ".."), { recursive: true, force: true });
    else rmSync(f, { force: true });
  }

  mkdirSync(walrusHome(), { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify(next, null, 2));
  return result;
}
