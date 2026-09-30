import { homedir } from "node:os";
import { isAbsolute, join, resolve, dirname, relative } from "node:path";
import { mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import type { Tool } from "../types";

// what tool results call a file: relative inside the working directory, as the model named it
const shown = (full: string, cwd: string) => {
  const rel = relative(cwd, full);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel.replaceAll("\\", "/") : full;
};

export function resolvePath(p: unknown, cwd: string): string {
  // models copy "@file" mentions verbatim into paths
  const s = String(p ?? ".").replace(/^@(?=[\w.~/\\])/, "");
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) return join(homedir(), s.slice(1));
  return isAbsolute(s) ? s : resolve(cwd, s);
}

const SKIP = /(^|[\\/])(node_modules|\.git|dist|target|\.venv|__pycache__)([\\/]|$)/;

export const readFile: Tool = {
  name: "read_file",
  description: "Read a text file. Returns numbered lines. Use offset/limit for large files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute, relative to cwd, or ~/...)" },
      offset: { type: "number", description: "First line to read, 1-based (default 1)" },
      limit: { type: "number", description: "Max lines (default 400)" },
    },
    required: ["path"],
  },
  async execute({ path, offset, limit }, ctx) {
    const file = Bun.file(resolvePath(path, ctx.cwd));
    if (!(await file.exists())) return `error: no such file ${path}`;
    const lines = (await file.text()).split(/\r?\n/);
    const start = Math.max(1, Number(offset) || 1);
    const count = Number(limit) || 400;
    const slice = lines.slice(start - 1, start - 1 + count);
    const body = slice.map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join("\n");
    const rest = lines.length - (start - 1 + slice.length);
    return rest > 0 ? `${body}\n… ${rest} more lines (use offset=${start + slice.length})` : body;
  },
};

export const writeFile: Tool = {
  name: "write_file",
  description: "Create or overwrite a file with the given content. Creates parent folders.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string", description: "Full file contents" },
    },
    required: ["path", "content"],
  },
  async execute({ path, content }, ctx) {
    const full = resolvePath(path, ctx.cwd);
    mkdirSync(dirname(full), { recursive: true });
    const text = String(content ?? "");
    await Bun.write(full, text);
    return `wrote ${text.split("\n").length} lines to ${shown(full, ctx.cwd)}`;
  },
};

// Small models often get blank lines or indentation slightly wrong in `old`, or cut its first or
// last line short. Returns the spans that match once blank lines and indentation are ignored, where
// the first line may be the end of a line and the last line the start of one.
export function looseMatches(text: string, needle: string): Array<[number, number]> {
  const want = needle.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!want.length) return [];
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const starts: number[] = [];
  let at = 0;
  for (const l of text.split("\n")) {
    starts.push(at);
    at += l.length + 1;
  }
  const last = want.length - 1;
  const fits = (t: string, k: number) =>
    t === want[k] || (last > 0 && ((k === 0 && t.endsWith(want[0]!)) || (k === last && t.startsWith(want[last]!))));
  const hits: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!fits(lines[i]!.trim(), 0)) continue;
    let j = i;
    let k = 0;
    while (j < lines.length && k < want.length) {
      const t = lines[j]!.trim();
      if (t && !fits(t, k)) break;
      if (t) k++;
      j++;
    }
    if (k < want.length) continue;
    const first = lines[i]!;
    const end = lines[j - 1]!;
    const from = first.trim() === want[0] ? 0 : first.lastIndexOf(want[0]!);
    const to = end.trim() === want[last] ? end.length : end.indexOf(want[last]!) + want[last]!.length;
    hits.push([starts[i]! + from, starts[j - 1]! + to]);
  }
  return hits;
}

// Small models retry the same wrong `old` unless they see what is really there.
function notFound(text: string) {
  const head =
    "error: `old` text not found. Copy `old` exactly from the file. " +
    "To add text, set `old` to the line it goes after and `new` to that line plus the addition.";
  return text.split("\n").length <= 60 ? `${head}\nThe file is:\n${text}` : `${head} Read the file first.`;
}

export const editFile: Tool = {
  name: "edit_file",
  description:
    "Replace exact text in a file. `old` must match exactly once (include surrounding lines to make it unique). " +
    "To add text, set `old` to the line it goes after and `new` to that line plus the addition.",
  mutates: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old: { type: "string", description: "Exact text to find" },
      new: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old", "new"],
  },
  async execute({ path, old, new: replacement }, ctx) {
    const full = resolvePath(path, ctx.cwd);
    const file = Bun.file(full);
    if (!(await file.exists())) return `error: no such file ${path}`;
    const text = await file.text();
    const needle = String(old ?? "");
    if (!needle) return "error: `old` is empty";
    const count = text.split(needle).length - 1;
    if (count > 1) return `error: \`old\` matches ${count} times — include more surrounding text`;
    let updated: string;
    if (count === 1) updated = text.replace(needle, () => String(replacement ?? ""));
    else {
      const loose = looseMatches(text, needle);
      if (!loose.length) return notFound(text);
      if (loose.length > 1) return `error: \`old\` matches ${loose.length} times — include more surrounding text`;
      const [a, b] = loose[0]!;
      updated = text.slice(0, a) + String(replacement ?? "") + text.slice(b);
    }
    await Bun.write(full, updated);
    return `edited ${shown(full, ctx.cwd)}`;
  },
};

export const listDir: Tool = {
  name: "list_dir",
  description:
    "List a directory, or find files recursively with a glob pattern like **/*.ts. Skips node_modules/.git.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory (default cwd)" },
      pattern: { type: "string", description: "Optional glob, e.g. **/*.py" },
    },
  },
  async execute({ path, pattern }, ctx) {
    const dir = resolvePath(path, ctx.cwd);
    if (!existsSync(dir)) return `error: no such directory ${path}`;
    if (!pattern) {
      return readdirSync(dir)
        .map((name) => {
          try {
            return statSync(join(dir, name)).isDirectory() ? `${name}/` : name;
          } catch {
            return name;
          }
        })
        .join("\n") || "(empty)";
    }
    const out: string[] = [];
    for await (const f of new Bun.Glob(String(pattern)).scan({ cwd: dir, onlyFiles: true })) {
      if (SKIP.test(f)) continue;
      out.push(f.replaceAll("\\", "/"));
      if (out.length >= 300) {
        out.push("… truncated at 300");
        break;
      }
    }
    return out.join("\n") || "no matches";
  },
};

export const grep: Tool = {
  name: "grep",
  description: "Search file contents with a regex. Returns path:line: text. Skips node_modules/.git.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regex" },
      path: { type: "string", description: "Directory or file (default cwd)" },
      glob: { type: "string", description: "File filter, e.g. **/*.ts (default **/*)" },
    },
    required: ["pattern"],
  },
  async execute({ pattern, path, glob }, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(String(pattern), "i");
    } catch (e) {
      return `error: bad regex: ${(e as Error).message}`;
    }
    const root = resolvePath(path, ctx.cwd);
    if (!existsSync(root)) return `error: no such path ${path}`;
    const files: string[] = [];
    if (statSync(root).isFile()) files.push(root);
    else
      for await (const f of new Bun.Glob(String(glob || "**/*")).scan({ cwd: root, onlyFiles: true })) {
        if (!SKIP.test(f)) files.push(join(root, f));
      }
    const hits: string[] = [];
    for (const f of files) {
      if (ctx.signal.aborted) break;
      const file = Bun.file(f);
      if (file.size > 1_000_000) continue;
      const text = await file.text();
      if (text.includes("\0")) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          hits.push(`${relative(ctx.cwd, f).replaceAll("\\", "/")}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          if (hits.length >= 100) return hits.join("\n") + "\n… truncated at 100";
        }
      }
    }
    return hits.join("\n") || "no matches";
  },
};
