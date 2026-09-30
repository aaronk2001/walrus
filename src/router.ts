import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { walrusHome, type Config } from "./config";
import { KEEP_ALIVE } from "./agent/ollama";
import type { Skill } from "./catalog";

// Calibrated on nomic-embed-text against real skill descriptions: it scores nearly everything 0.5-0.6,
// so a match must be both absolutely high and clearly above the other skills for this query.
const MIN_SCORE = 0.58;
const MIN_Z = 1.4;
const FALLBACK_CAP = 25;

type Cache = { model: string; vectors: Record<string, number[]> };

const cachePath = () => join(walrusHome(), "cache", "skill-embeddings.json");
let cache: Cache | null = null;

function loadCache(model: string): Cache {
  if (cache?.model === model) return cache;
  try {
    const c = JSON.parse(readFileSync(cachePath(), "utf8")) as Cache;
    cache = c.model === model ? c : { model, vectors: {} };
  } catch {
    cache = { model, vectors: {} };
  }
  return cache;
}

function saveCache() {
  if (!cache) return;
  mkdirSync(join(walrusHome(), "cache"), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify(cache));
}

const keyOf = (s: Skill) => createHash("sha1").update(`${s.name}\0${s.description}`).digest("hex");

export async function embed(host: string, model: string, input: string[]): Promise<number[][]> {
  const res = await fetch(`${host}/api/embed`, {
    method: "POST",
    body: JSON.stringify({ model, input, keep_alive: KEEP_ALIVE }),
    timeout: false,
  });
  const j = (await res.json()) as { embeddings?: number[][]; error?: string };
  if (!res.ok || !j.embeddings) throw new Error(j.error ?? `embed ${res.status}`);
  return j.embeddings;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

// Embeds any enabled skills missing from the cache. Safe to call in the background at startup.
export async function indexSkills(cfg: Config, skills: Skill[]): Promise<void> {
  if (!cfg.embedModel) return;
  const c = loadCache(cfg.embedModel);
  const todo = skills.filter((s) => s.enabled && !c.vectors[keyOf(s)]);
  if (!todo.length) return;
  for (let i = 0; i < todo.length; i += 32) {
    const batch = todo.slice(i, i + 32);
    const vecs = await embed(
      cfg.ollamaHost,
      cfg.embedModel,
      batch.map((s) => `search_document: ${s.name.replace(/[-_]/g, " ")}: ${s.description}`),
    );
    batch.forEach((s, j) => (c.vectors[keyOf(s)] = vecs[j]!));
  }
  saveCache();
}

export interface Pick {
  skills: Skill[];
  routed: boolean; // false = embedding unavailable, fell back to listing
}

// Chooses which enabled skills to show the model for this request.
export async function pickSkills(cfg: Config, skills: Skill[], query: string): Promise<Pick> {
  const enabled = skills.filter((s) => s.enabled);
  if (!enabled.length) return { skills: [], routed: true };
  const named = enabled.filter((s) => query.toLowerCase().includes(s.name.toLowerCase()));
  if (!cfg.embedModel) return { skills: enabled.slice(0, FALLBACK_CAP), routed: false };
  try {
    await indexSkills(cfg, skills);
    const [q] = await embed(cfg.ollamaHost, cfg.embedModel, [`search_query: ${query.slice(0, 2000)}`]);
    const c = loadCache(cfg.embedModel);
    const scored = enabled.map((s) => ({ s, score: cosine(q!, c.vectors[keyOf(s)] ?? []) }));
    const mean = scored.reduce((n, x) => n + x.score, 0) / scored.length;
    const sd = Math.sqrt(scored.reduce((n, x) => n + (x.score - mean) ** 2, 0) / scored.length) || 1;
    const ranked = scored
      .filter((x) => x.score >= MIN_SCORE && (scored.length < 4 || (x.score - mean) / sd >= MIN_Z))
      .sort((a, b) => b.score - a.score)
      .slice(0, cfg.skillTopK)
      .map((x) => x.s);
    return { skills: [...new Set([...named, ...ranked])], routed: true };
  } catch {
    return { skills: enabled.slice(0, FALLBACK_CAP), routed: false };
  }
}

export const hasCache = () => existsSync(cachePath());
