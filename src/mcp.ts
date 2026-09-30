import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { claudeHome, walrusHome } from "./config";
import type { Tool } from "./agent/types";
import { VERSION } from "./version";
import { opencodeMcpServers } from "./opencode";

export interface ServerSpec {
  name: string;
  source: "walrus" | "claude" | "plugin" | "opencode";
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  // as written in the config, before ${VAR} expansion; used when exporting so secrets stay out of files
  raw?: RawSpec;
}

export type RawSpec = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ${VAR} and ${VAR:-default}, as in Claude Code's .mcp.json
export const expandEnv = (s: string) =>
  s.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, v: string, d?: string) => process.env[v] ?? d ?? "");

function toSpec(name: string, raw: RawSpec, source: ServerSpec["source"]): ServerSpec | null {
  const map = (o?: Record<string, string>) =>
    o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expandEnv(String(v))])) : undefined;
  if (raw.url && raw.type !== "stdio") {
    if (raw.type === "sse") return null; // legacy transport, not supported
    return { name, source, type: "http", url: expandEnv(raw.url), headers: map(raw.headers), raw };
  }
  if (!raw.command) return null;
  return {
    name,
    source,
    type: "stdio",
    command: expandEnv(raw.command),
    args: (raw.args ?? []).map(expandEnv),
    env: map(raw.env),
    raw,
  };
}

function latestDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const dirs = readdirSync(dir)
    .map((d) => join(dir, d))
    .filter((p) => statSync(p).isDirectory())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return dirs[0] ?? null;
}

export function discoverServers(cwd: string): ServerSpec[] {
  const out = new Map<string, ServerSpec>();
  const add = (servers: unknown, source: ServerSpec["source"]) => {
    if (!servers || typeof servers !== "object") return;
    for (const [name, raw] of Object.entries(servers as Record<string, RawSpec>)) {
      const spec = toSpec(name, raw, source);
      if (spec && !out.has(name)) out.set(name, spec);
    }
  };
  add(readJson(join(walrusHome(), "mcp.json"))?.mcpServers, "walrus");

  const claudeJson = readJson(process.env.CLAUDE_JSON ?? join(homedir(), ".claude.json"));
  add(claudeJson?.mcpServers, "claude");
  const projects = (claudeJson?.projects ?? {}) as Record<string, { mcpServers?: unknown }>;
  const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();
  for (const [p, v] of Object.entries(projects)) if (norm(p) === norm(cwd)) add(v.mcpServers, "claude");
  add(readJson(join(cwd, ".mcp.json"))?.mcpServers, "claude");

  const settings = readJson(join(claudeHome(), "settings.json"));
  const enabled = Object.entries((settings?.enabledPlugins ?? {}) as Record<string, boolean>).filter(([, on]) => on);
  for (const [id] of enabled) {
    const [plugin, market] = id.split("@");
    const dir = latestDir(join(claudeHome(), "plugins", "cache", market!, plugin!));
    if (dir) add(readJson(join(dir, ".mcp.json"))?.mcpServers, "plugin");
  }
  add(opencodeMcpServers(cwd), "opencode");
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export interface Connection {
  spec: ServerSpec;
  client: Client;
  tools: Tool[];
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

export async function connect(spec: ServerSpec): Promise<Connection> {
  const client = new Client({ name: "walrus", version: VERSION });
  const transport =
    spec.type === "http"
      ? new StreamableHTTPClientTransport(new URL(spec.url!), { requestInit: { headers: spec.headers } })
      : new StdioClientTransport({
          command: spec.command!,
          args: spec.args,
          env: { ...(process.env as Record<string, string>), ...spec.env },
          stderr: "ignore",
        });
  await Promise.race([
    client.connect(transport),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timed out connecting (20s)")), 20_000)),
  ]);
  const { tools } = await client.listTools();
  return {
    spec,
    client,
    tools: tools.map(
      (t): Tool => ({
        name: `mcp__${safeName(spec.name)}__${safeName(t.name)}`,
        description: `[${spec.name}] ${t.description ?? t.name}`.slice(0, 1000),
        parameters: {
          type: "object",
          properties: (t.inputSchema?.properties ?? {}) as Record<string, unknown>,
          required: t.inputSchema?.required as string[] | undefined,
        },
        mutates: !t.annotations?.readOnlyHint,
        async execute(args) {
          const res = await client.callTool({ name: t.name, arguments: args });
          const parts = (res.content as Array<{ type: string; text?: string }> | undefined) ?? [];
          const text = parts.map((p) => (p.type === "text" ? p.text : `[${p.type} content]`)).join("\n");
          return res.isError ? `error: ${text}` : text || "(no content)";
        },
      }),
    ),
  };
}
