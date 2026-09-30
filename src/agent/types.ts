export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export interface ToolCtx {
  cwd: string;
  signal: AbortSignal;
  // Nested agent runner, absent inside subagents so they cannot recurse.
  runSubagent?: (name: string, task: string) => Promise<string>;
  readSkill?: (name: string) => string | null;
}

export interface Tool {
  name: string;
  description: string;
  parameters: ToolSchema["function"]["parameters"];
  mutates?: boolean;
  // What "always allow" covers when narrower than the whole tool, e.g. one host.
  scope?: (args: Record<string, unknown>) => string;
  execute: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<string> | string;
}

export type AgentEvent =
  | { type: "thinking"; text: string; agent?: string }
  | { type: "token"; text: string; agent?: string }
  | { type: "reset"; agent?: string }
  | { type: "skills"; names: string[]; routed: boolean }
  | { type: "tool_start"; tool: string; input: Record<string, unknown>; agent?: string }
  | { type: "tool_end"; tool: string; result: string; ok: boolean; agent?: string }
  | { type: "usage"; promptTokens: number; outputTokens: number; agent?: string }
  | { type: "answer"; text: string; agent?: string }
  | { type: "error"; message: string; agent?: string };

export type PermissionDecision = "yes" | "always" | "no";
