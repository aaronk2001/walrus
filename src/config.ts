import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

export type Mode = "ask" | "auto";

export interface Config {
  model: string;
  ollamaHost: string;
  numCtx: number;
  think: boolean;
  embedModel: string;
  skillTopK: number;
  mode: Mode;
  skills: Record<string, boolean>;
  agents: Record<string, boolean>;
  tools: Record<string, boolean>;
  mcp: Record<string, boolean>;
  skillDirs: string[];
}

export const DEFAULTS: Config = {
  model: "qwen3:1.7b",
  ollamaHost: "http://localhost:11434",
  numCtx: 8192,
  think: false,
  embedModel: "nomic-embed-text",
  skillTopK: 5,
  mode: "ask",
  skills: {},
  agents: {},
  tools: {},
  mcp: {},
  skillDirs: [],
};

export const walrusHome = () => process.env.WALRUS_HOME ?? join(homedir(), ".walrus");
export const claudeHome = () => process.env.CLAUDE_HOME ?? join(homedir(), ".claude");
const configPath = () => join(walrusHome(), "config.json");

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return structuredClone(DEFAULTS);
  try {
    return { ...structuredClone(DEFAULTS), ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg: Config) {
  mkdirSync(walrusHome(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
