import type { ChatMessage, ToolCall, ToolSchema } from "./types";

export interface ChatChunk {
  message?: { role: string; content?: string; thinking?: string; tool_calls?: ToolCall[] };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

async function* ndjson<T>(res: Response): AsyncGenerator<T> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }
  if (buf.trim()) yield JSON.parse(buf) as T;
}

export const KEEP_ALIVE = "30m";

// Loads the model into memory ahead of the first prompt.
export async function warmModel(host: string, model: string, numCtx: number): Promise<void> {
  const res = await fetch(`${host}/api/generate`, {
    method: "POST",
    body: JSON.stringify({ model, keep_alive: KEEP_ALIVE, options: { num_ctx: numCtx } }),
    timeout: false,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  await res.text();
}

export async function* chatStream(opts: {
  host: string;
  model: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  numCtx: number;
  think?: boolean;
  signal?: AbortSignal;
}): AsyncGenerator<ChatChunk> {
  const res = await fetch(`${opts.host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools.length ? opts.tools : undefined,
      stream: true,
      think: opts.think,
      keep_alive: KEEP_ALIVE,
      options: { num_ctx: opts.numCtx },
    }),
    signal: opts.signal,
    // small models on a busy GPU can go minutes between tokens (model load, prompt eval)
    timeout: false,
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  for await (const chunk of ndjson<ChatChunk>(res)) {
    // once the reply has started, Ollama reports failures as a line, not an HTTP status
    if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
    yield chunk;
  }
}

export interface ModelInfo {
  name: string;
  size: number;
  params: string;
  quant: string;
  family: string;
}

export async function listModels(host: string): Promise<ModelInfo[]> {
  const res = await fetch(`${host}/api/tags`);
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = (await res.json()) as {
    models?: Array<{
      name: string;
      size: number;
      details?: { parameter_size?: string; quantization_level?: string; family?: string };
    }>;
  };
  return (data.models ?? [])
    .map((m) => ({
      name: m.name,
      size: m.size,
      params: m.details?.parameter_size ?? "",
      quant: m.details?.quantization_level ?? "",
      family: m.details?.family ?? "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadedModels(host: string): Promise<string[]> {
  try {
    const res = await fetch(`${host}/api/ps`);
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export async function modelCapabilities(host: string, model: string): Promise<string[]> {
  try {
    const res = await fetch(`${host}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    const data = (await res.json()) as { capabilities?: string[] };
    return data.capabilities ?? [];
  } catch {
    return [];
  }
}

// A model alias with a larger default context; shares the base model's weights, so it costs no disk.
export async function createContextVariant(host: string, from: string, name: string, numCtx: number): Promise<void> {
  const res = await fetch(`${host}/api/create`, {
    method: "POST",
    body: JSON.stringify({ model: name, from, parameters: { num_ctx: numCtx }, stream: false }),
    timeout: false,
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  await res.text();
}

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
  error?: string;
}

export async function* pullModel(host: string, model: string, signal?: AbortSignal) {
  const res = await fetch(`${host}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true }),
    signal,
    timeout: false,
  });
  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  yield* ndjson<PullProgress>(res);
}
