import type { Tool } from "./types";

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Small models misspell tool names ("listDir", "read-file", "functions.bash"); map to a real tool.
export function resolveTool(name: string, tools: Tool[]): Tool | undefined {
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;
  const bare = name.split(/[.:/]/).pop() ?? name;
  const s = squash(bare);
  const loose = tools.find((t) => squash(t.name) === s);
  if (loose) return loose;
  let best: Tool | undefined;
  let bestD = Infinity;
  for (const t of tools) {
    const d = editDistance(s, squash(t.name));
    if (d < bestD) [best, bestD] = [t, d];
  }
  return bestD <= 2 ? best : undefined;
}

type Schema = { type?: string; enum?: unknown[] };

// Coerces common type slips and reports what is still wrong, phrased for the model to fix.
export function repairArgs(
  tool: Tool,
  raw: unknown,
): { args: Record<string, unknown>; problem: string | null } {
  let args: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      args = JSON.parse(raw);
    } catch {
      return { args: {}, problem: "arguments were not valid JSON" };
    }
  } else if (raw && typeof raw === "object") args = { ...(raw as Record<string, unknown>) };

  const props = tool.parameters.properties as Record<string, Schema>;
  for (const [key, schema] of Object.entries(props)) {
    const v = args[key];
    if (v === undefined || v === null) continue;
    if (schema.type === "number" && typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) args[key] = Number(v);
    if (schema.type === "string" && typeof v !== "string") args[key] = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (schema.type === "array" && typeof v === "string") {
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) args[key] = parsed;
      } catch {
        /* reported below */
      }
    }
  }

  const missing = (tool.parameters.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  const wrong = Object.entries(props)
    .filter(([k, s]) => args[k] !== undefined && s.type === "array" && !Array.isArray(args[k]))
    .map(([k]) => k);
  if (!missing.length && !wrong.length) return { args, problem: null };
  const expected = Object.entries(props)
    .map(([k, s]) => `${k}: ${s.type ?? "any"}${tool.parameters.required?.includes(k) ? " (required)" : ""}`)
    .join(", ");
  const parts = [
    missing.length && `missing required argument${missing.length > 1 ? "s" : ""} ${missing.map((m) => `\`${m}\``).join(", ")}`,
    wrong.length && `${wrong.map((w) => `\`${w}\``).join(", ")} must be an array`,
  ].filter(Boolean);
  return { args, problem: `${parts.join("; ")}. ${tool.name} expects {${expected}}. Call it again with correct arguments.` };
}
