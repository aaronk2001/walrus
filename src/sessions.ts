import { join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { walrusHome } from "./config";
import type { ChatMessage } from "./agent/types";

export interface SavedSession<Item = unknown> {
  id: string;
  cwd: string;
  model: string;
  title: string;
  created: string;
  updated: string;
  history: ChatMessage[];
  items: Item[];
}

const dir = () => join(walrusHome(), "sessions");
const historyFile = () => join(walrusHome(), "history.jsonl");

export const newSessionId = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "-" + Math.random().toString(36).slice(2, 6);

export function saveSession<I>(s: SavedSession<I>) {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(join(dir(), `${s.id}.json`), JSON.stringify(s));
}

export function loadSession<I>(id: string): SavedSession<I> | null {
  try {
    return JSON.parse(readFileSync(join(dir(), `${id}.json`), "utf8"));
  } catch {
    return null;
  }
}

export interface SessionMeta {
  id: string;
  cwd: string;
  model: string;
  title: string;
  updated: string;
  turns: number;
}

// Newest first; sessions from `cwd` sort ahead of others.
export function listSessions(cwd?: string, limit = 30): SessionMeta[] {
  if (!existsSync(dir())) return [];
  const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();
  const metas: SessionMeta[] = [];
  for (const f of readdirSync(dir())) {
    if (!f.endsWith(".json")) continue;
    const s = loadSession(f.slice(0, -5));
    if (!s) continue;
    metas.push({
      id: s.id,
      cwd: s.cwd,
      model: s.model,
      title: s.title,
      updated: s.updated,
      turns: s.history.filter((m) => m.role === "user").length,
    });
  }
  return metas
    .sort((a, b) => {
      if (cwd) {
        const d = Number(norm(b.cwd) === norm(cwd)) - Number(norm(a.cwd) === norm(cwd));
        if (d) return d;
      }
      return b.updated.localeCompare(a.updated);
    })
    .slice(0, limit);
}

export function loadPromptHistory(max = 200): string[] {
  try {
    return readFileSync(historyFile(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string)
      .slice(-max);
  } catch {
    return [];
  }
}

export function appendPromptHistory(text: string) {
  mkdirSync(walrusHome(), { recursive: true });
  appendFileSync(historyFile(), JSON.stringify(text) + "\n");
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
