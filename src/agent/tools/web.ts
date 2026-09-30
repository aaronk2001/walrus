import type { Tool } from "../types";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36";

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h\d|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const hostOf = (url: unknown) => {
  try {
    return new URL(String(url)).host;
  } catch {
    return String(url);
  }
};

export const webFetch: Tool = {
  name: "web_fetch",
  description: "Fetch a URL and return its readable text (HTML stripped).",
  // not a change, but a URL can carry file contents off the machine, so it asks like one
  mutates: true,
  scope: ({ url }) => hostOf(url),
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Full URL including https://" } },
    required: ["url"],
  },
  async execute({ url }, ctx) {
    const res = await fetch(String(url), { headers: { "User-Agent": UA }, signal: ctx.signal });
    const body = await res.text();
    const text = /html/i.test(res.headers.get("content-type") ?? "") ? htmlToText(body) : body;
    return `HTTP ${res.status}\n${text}`;
  },
};

export const webSearch: Tool = {
  name: "web_search",
  description: "Search the web (DuckDuckGo). Returns titles, URLs, and snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", description: "Max results (default 5)" },
    },
    required: ["query"],
  },
  async execute({ query, limit }, ctx) {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(query))}`, {
      headers: { "User-Agent": UA },
      signal: ctx.signal,
    });
    const html = await res.text();
    const re =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const max = Number(limit) || 5;
    const out: string[] = [];
    for (const m of html.matchAll(re)) {
      const href = m[1]!.match(/uddg=([^&]+)/);
      const url = href ? decodeURIComponent(href[1]!) : m[1]!;
      out.push(`${out.length + 1}. ${htmlToText(m[2]!)}\n${url}\n${htmlToText(m[3]!)}`);
      if (out.length >= max) break;
    }
    return out.join("\n\n") || "no results";
  },
};
