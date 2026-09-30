export interface Parsed {
  data: Record<string, string>;
  body: string;
}

const unquote = (s: string) => (/^(["']).*\1$/.test(s) ? s.slice(1, -1) : s);

// Minimal YAML frontmatter: scalar keys, quoted strings, `>`/`|` block scalars, and lists,
// which come back comma-separated (`tools:` + `- Read` lines reads as "Read, Grep").
export function parseFrontmatter(src: string): Parsed {
  const text = src.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  const lines = m[1]!.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i]!.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, raw] = kv as unknown as [string, string, string];
    let value = raw.trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]!) || lines[i + 1] === "")) {
        block.push(lines[++i]!.trim());
      }
      value = value.startsWith(">") ? block.join(" ").trim() : block.join("\n").trim();
    } else if (!value && /^\s*-\s/.test(lines[i + 1] ?? "")) {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s/.test(lines[i + 1]!)) {
        items.push(unquote(lines[++i]!.replace(/^\s*-\s+/, "").trim()));
      }
      value = items.join(", ");
    } else if (/^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean).join(", ");
    } else {
      value = unquote(value);
    }
    data[key] = value;
  }
  return { data, body: text.slice(m[0].length) };
}
