import { existsSync, statSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { resolvePath } from "./agent/tools/fs";

const MAX_FILE_CHARS = 20_000;
const SKIP = /(^|\/)(node_modules|\.git|dist|target|\.venv|__pycache__|build|\.next)(\/|$)/;

let fileCache: { cwd: string; files: string[]; at: number } | null = null;

// Relative paths under cwd for @-completion. Cached for 30s; capped so huge trees stay fast.
export async function listFiles(cwd: string): Promise<string[]> {
  if (fileCache && fileCache.cwd === cwd && Date.now() - fileCache.at < 30_000) return fileCache.files;
  const files: string[] = [];
  for await (const f of new Bun.Glob("**/*").scan({ cwd, onlyFiles: true, dot: false })) {
    const p = f.replaceAll("\\", "/");
    if (SKIP.test(p)) continue;
    files.push(p);
    if (files.length >= 5000) break;
  }
  fileCache = { cwd, files, at: Date.now() };
  return files;
}

// Ranks paths for a partial @mention: basename prefix, then basename contains, then path contains.
export function matchFiles(files: string[], q: string, limit = 6): string[] {
  const query = q.toLowerCase();
  const scored: Array<[number, string]> = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const score = base.startsWith(query) ? 0 : base.includes(query) ? 1 : lower.includes(query) ? 2 : -1;
    if (score >= 0) scored.push([score * 1000 + f.length, f]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, f]) => f);
}

// The @token the cursor is in, if any.
export function mentionAt(value: string, cursor: number): { start: number; query: string } | null {
  const left = value.slice(0, cursor);
  const m = left.match(/(?:^|\s)@([^\s@]*)$/);
  return m ? { start: cursor - m[1]!.length - 1, query: m[1]! } : null;
}

// Appends the contents of every @path that exists to the prompt.
export function expandMentions(text: string, cwd: string): { prompt: string; files: string[] } {
  const files: string[] = [];
  const blocks: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const raw = m[1]!.replace(/[.,;:!?)]+$/, "");
    const full = resolvePath(raw, cwd);
    if (!existsSync(full) || files.includes(full)) continue;
    const st = statSync(full);
    if (!st.isFile()) continue;
    let body = readFileSync(full, "utf8");
    if (body.includes("\0")) continue;
    if (body.length > MAX_FILE_CHARS) body = body.slice(0, MAX_FILE_CHARS) + `\n… [truncated, ${st.size} bytes total]`;
    files.push(full);
    blocks.push(`<file path="${relative(cwd, full).replaceAll("\\", "/")}">\n${body}\n</file>`);
  }
  return { prompt: blocks.length ? `${text}\n\n${blocks.join("\n\n")}` : text, files };
}
