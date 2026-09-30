import { chatStream } from "./ollama";
import { toSchema } from "./tools";
import { repairArgs, resolveTool } from "./repair";
import type { AgentEvent, ChatMessage, PermissionDecision, Tool, ToolCall, ToolCtx } from "./types";

export const MAX_TOOL_OUTPUT = 8000;

export interface LoopOptions {
  host: string;
  model: string;
  numCtx: number;
  // only set for models with the "thinking" capability; Ollama rejects it otherwise
  think?: boolean;
  messages: ChatMessage[];
  tools: Tool[];
  toolDescriptions?: Record<string, string>;
  ctx: ToolCtx;
  maxIterations?: number;
  agent?: string;
  emit: (e: AgentEvent) => void;
  askPermission: (tool: Tool, input: Record<string, unknown>) => Promise<PermissionDecision>;
}

// Splits streamed text into visible content and <think> reasoning, across chunk boundaries.
// A stray </think> with no opener (qwen3 with thinking "off") means everything before it was
// reasoning: `reset` tells the caller to reclassify content it already received.
export function thinkSplitter() {
  let inThink = false;
  let pending = "";
  const OPEN = "<think>";
  const CLOSE = "</think>";
  return (chunk: string): { content: string; thinking: string; reset: boolean } => {
    let text = pending + chunk;
    pending = "";
    let content = "";
    let thinking = "";
    let reset = false;
    while (text) {
      const close = text.indexOf(CLOSE);
      const open = inThink ? -1 : text.indexOf(OPEN);
      const useOpen = !inThink && open !== -1 && (close === -1 || open < close);
      const idx = useOpen ? open : close;
      if (idx === -1) {
        let keep = 0;
        for (let k = Math.min(CLOSE.length - 1, text.length); k > 0; k--) {
          const tail = text.slice(-k);
          if (CLOSE.startsWith(tail) || (!inThink && OPEN.startsWith(tail))) {
            keep = k;
            break;
          }
        }
        const out = text.slice(0, text.length - keep);
        pending = text.slice(text.length - keep);
        if (inThink) thinking += out;
        else content += out;
        break;
      }
      const before = text.slice(0, idx);
      if (useOpen) {
        content += before;
        inThink = true;
        text = text.slice(idx + OPEN.length);
      } else if (inThink) {
        thinking += before;
        inThink = false;
        text = text.slice(idx + CLOSE.length);
      } else {
        thinking += content + before;
        content = "";
        reset = true;
        text = text.slice(idx + CLOSE.length);
      }
    }
    return { content, thinking, reset };
  };
}

// Small models sometimes print the tool call instead of emitting it natively.
export function parseInlineToolCalls(content: string): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const m of content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    try {
      const j = JSON.parse(m[1]!);
      if (j?.name) calls.push({ function: { name: j.name, arguments: j.arguments ?? {} } });
    } catch {
      /* not JSON; leave as text */
    }
  }
  return calls;
}

const LOOKS_LIKE_CALL = /^\s*(```(json)?\s*|<\w+>\s*)?\{\s*"name"\s*:\s*"[\w.:-]+"\s*,\s*"(arguments|parameters)"/;

// Others print a bare `{"name": …, "arguments": …}` object (or a ```json block) as the whole reply.
export function parseBareToolCall(content: string): ToolCall | null {
  const body = content
    .trim()
    .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1")
    .replace(/^<(\w+)>\s*([\s\S]*?)\s*<\/\1>$/, "$2");
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  try {
    const j = JSON.parse(body);
    if (typeof j?.name !== "string" || !("arguments" in j || "parameters" in j)) return null;
    return { function: { name: j.name, arguments: j.arguments ?? j.parameters ?? {} } };
  } catch {
    return null;
  }
}

export function clipOutput(s: string): string {
  return s.length > MAX_TOOL_OUTPUT
    ? `${s.slice(0, MAX_TOOL_OUTPUT)}\n… [${s.length - MAX_TOOL_OUTPUT} chars truncated]`
    : s;
}

export async function runLoop(o: LoopOptions): Promise<ChatMessage[]> {
  const { emit, agent } = o;
  const messages = o.messages;
  const schemas = o.tools.map((t) => toSchema(t, o.toolDescriptions?.[t.name]));
  const max = o.maxIterations ?? 30;

  for (let iter = 0; iter < max; iter++) {
    const split = thinkSplitter();
    let content = "";
    const toolCalls: ToolCall[] = [];
    try {
      for await (const chunk of chatStream({
        host: o.host,
        model: o.model,
        messages,
        tools: schemas,
        numCtx: o.numCtx,
        think: o.think,
        signal: o.ctx.signal,
      })) {
        const msg = chunk.message;
        if (msg?.thinking) emit({ type: "thinking", text: msg.thinking, agent });
        if (msg?.content) {
          const part = split(msg.content);
          if (part.reset && content) {
            emit({ type: "thinking", text: content, agent });
            content = "";
            emit({ type: "reset", agent });
          }
          if (part.thinking) emit({ type: "thinking", text: part.thinking, agent });
          if (part.content) {
            content += part.content;
            emit({ type: "token", text: part.content, agent });
          }
        }
        if (msg?.tool_calls?.length) toolCalls.push(...msg.tool_calls);
        if (chunk.done) {
          emit({
            type: "usage",
            promptTokens: chunk.prompt_eval_count ?? 0,
            outputTokens: chunk.eval_count ?? 0,
            agent,
          });
        }
      }
    } catch (e) {
      if (o.ctx.signal.aborted) emit({ type: "error", message: "interrupted", agent });
      else emit({ type: "error", message: (e as Error).message, agent });
      return messages;
    }

    if (!toolCalls.length && o.tools.length) {
      const raw = content;
      const inline = parseInlineToolCalls(content);
      const bare = inline.length ? null : parseBareToolCall(content);
      if (inline.length) {
        toolCalls.push(...inline);
        content = content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
      } else if (bare && resolveTool(bare.function.name, o.tools)) {
        toolCalls.push(bare);
        content = "";
      } else if (LOOKS_LIKE_CALL.test(content)) {
        // a tool call too broken to parse: ask for it again rather than showing JSON as the answer
        emit({ type: "reset", agent });
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: "That tool call was not valid JSON. Send it again as a proper tool call." });
        continue;
      }
      if (content !== raw) {
        // the streamed preview showed the raw call; replace it with what is left
        emit({ type: "reset", agent });
        if (content) emit({ type: "token", text: content, agent });
      }
    }

    messages.push({ role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });

    if (!toolCalls.length) {
      emit({ type: "answer", text: content.trim(), agent });
      return messages;
    }

    for (const call of toolCalls) {
      const tool = resolveTool(call.function.name, o.tools);
      const name = tool?.name ?? call.function.name;
      const fixed = tool ? repairArgs(tool, call.function.arguments) : null;
      const input = fixed?.args ?? (call.function.arguments as Record<string, unknown>) ?? {};
      emit({ type: "tool_start", tool: name, input, agent });
      let result: string;
      let ok = true;
      if (!tool) {
        ok = false;
        result = `error: unknown tool "${name}". Available: ${o.tools.map((t) => t.name).join(", ")}`;
      } else if (fixed?.problem) {
        ok = false;
        result = `error: ${fixed.problem}`;
      } else if (tool.mutates && (await o.askPermission(tool, input)) === "no") {
        ok = false;
        result = "The user denied this action. Ask what they want instead, or try another approach.";
      } else {
        try {
          result = clipOutput(await tool.execute(input, o.ctx));
          ok = !result.startsWith("error:");
        } catch (e) {
          ok = false;
          result = `error: ${(e as Error).message}`;
        }
      }
      emit({ type: "tool_end", tool: name, result, ok, agent });
      messages.push({ role: "tool", tool_name: name, content: result });
      if (o.ctx.signal.aborted) {
        emit({ type: "error", message: "interrupted", agent });
        return messages;
      }
    }
  }
  emit({ type: "error", message: `stopped after ${max} steps`, agent });
  return messages;
}
