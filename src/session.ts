import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { runLoop } from "./agent/loop";
import { ALL_TOOLS } from "./agent/tools";
import type { AgentEvent, ChatMessage, PermissionDecision, Tool } from "./agent/types";
import { clip, readBody, type Agent, type Skill } from "./catalog";
import type { Config } from "./config";
import { pickSkills } from "./router";

export function projectInstructions(cwd: string): string {
  for (const f of ["WALRUS.md", "CLAUDE.md", "AGENTS.md"]) {
    const p = join(cwd, f);
    if (existsSync(p)) return `\n\n# Project instructions (${f})\n${readFileSync(p, "utf8").slice(0, 4000)}`;
  }
  return "";
}

// Kept identical across turns so Ollama can reuse its prompt cache; per-request skills ride on the user message.
export function buildSystemPrompt(o: { cwd: string; tools: Tool[] }): string {
  const names = new Set(o.tools.map((t) => t.name));
  const lines = [
    "You are Walrus, a local coding and research assistant running in the user's terminal via Ollama.",
    `Working directory: ${o.cwd}`,
    `Platform: ${platform()} · Date: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "Rules:",
    ...(o.tools.length
      ? [
          "- Use tools to look before you answer questions about files or code. Never invent file contents.",
          "- Read a file before editing it. Keep edits small and exact.",
          "- Be brief. Answer in plain text when done; do not call tools after the task is finished.",
        ]
      : [
          "- This model has no tools: you cannot read files or run commands. Never invent file contents; ask the user to paste what you need.",
          "- Be brief.",
        ]),
  ];
  if (names.has("todo_write")) lines.push("- For tasks with 3+ steps, keep a todo list with todo_write.");
  if (names.has("skill")) {
    lines.push(
      "- Some requests come with <skills>. If one matches the request, call the `skill` tool with its name FIRST and follow what it returns.",
    );
  }
  return lines.join("\n") + projectInstructions(o.cwd);
}

export function skillsHint(skills: Skill[]): string {
  if (!skills.length) return "";
  return `\n\n<skills>\n${skills.map((s) => `- ${s.name}: ${clip(s.description, 140)}`).join("\n")}\n</skills>`;
}

export function agentToolDescription(base: string, agents: Agent[]): string {
  const enabled = agents.filter((a) => a.enabled);
  if (!enabled.length) return base;
  return `${base}\nAgents:\n${enabled.map((a) => `- ${a.name}: ${clip(a.description, 100)}`).join("\n")}`;
}

export interface SessionDeps {
  cfg: Config;
  cwd: string;
  skills: Skill[];
  agents: Agent[];
  // model name -> capabilities, from /api/show
  caps: Record<string, string[]>;
  extraTools?: Tool[];
  emit: (e: AgentEvent) => void;
  askPermission: (tool: Tool, input: Record<string, unknown>, agent?: string) => Promise<PermissionDecision>;
}

export function activeTools(cfg: Config, skills: Skill[], agents: Agent[], extra: Tool[] = []): Tool[] {
  return [...ALL_TOOLS, ...extra].filter((t) => {
    if (cfg.tools[t.name] === false) return false;
    if (t.name === "skill") return skills.some((s) => s.enabled);
    if (t.name === "agent") return agents.some((a) => a.enabled);
    return true;
  });
}

export function readSkillFor(skills: Skill[]) {
  return (name: string) => {
    const s = skills.find((x) => x.enabled && x.name.toLowerCase() === name.toLowerCase());
    return s ? `# Skill: ${s.name}\n(skill folder: ${s.path.replace(/SKILL\.md$/, "")})\n\n${readBody(s.path)}` : null;
  };
}

// Runs one user turn against `history` (mutated in place). Returns the updated history.
// `query` is what the user typed (before @file expansion); it is what skills are matched against.
export async function runTurn(
  deps: SessionDeps,
  history: ChatMessage[],
  input: string,
  signal: AbortSignal,
  query = input,
) {
  const { cfg, cwd, skills, agents, emit } = deps;
  const thinkFor = (model: string) => (deps.caps[model]?.includes("thinking") ? cfg.think : undefined);
  // Ollama rejects a request with tools (HTTP 400) for models without the capability, so those
  // models chat without them. No capabilities yet means /api/show hasn't answered: send tools.
  const canUseTools = (model: string) => {
    const caps = deps.caps[model] ?? [];
    return !caps.length || caps.includes("tools");
  };
  const tools = canUseTools(cfg.model) ? activeTools(cfg, skills, agents, deps.extraTools) : [];
  if (!history.length || history[0]!.role !== "system") {
    history.unshift({ role: "system", content: buildSystemPrompt({ cwd, tools }) });
  }
  let hint = "";
  if (tools.some((t) => t.name === "skill")) {
    const pick = await pickSkills(cfg, skills, query);
    emit({ type: "skills", names: pick.skills.map((s) => s.name), routed: pick.routed });
    hint = skillsHint(pick.skills);
  }
  history.push({ role: "user", content: input + hint });
  const readSkill = readSkillFor(skills);

  const runSubagent = async (name: string, task: string): Promise<string> => {
    const a = agents.find((x) => x.enabled && x.name.toLowerCase() === name.toLowerCase());
    if (!a) return `error: no enabled agent "${name}". Available: ${agents.filter((x) => x.enabled).map((x) => x.name).join(", ")}`;
    const subTools = canUseTools(a.model ?? cfg.model)
      ? tools.filter((t) => t.name !== "agent" && (a.tools === null || a.tools.includes(t.name) || t.name === "skill"))
      : [];
    const sys = [
      readBody(a.path),
      `\nYou are running as the "${a.name}" subagent inside Walrus. Working directory: ${cwd}.`,
      "Do the task with your tools, then reply with a concise final report. That report is all the caller sees.",
    ].join("\n");
    const msgs: ChatMessage[] = [
      { role: "system", content: sys },
      { role: "user", content: task },
    ];
    let answer = "";
    let err = "";
    await runLoop({
      host: cfg.ollamaHost,
      model: a.model ?? cfg.model,
      numCtx: cfg.numCtx,
      think: thinkFor(a.model ?? cfg.model),
      messages: msgs,
      tools: subTools,
      ctx: { cwd, signal, readSkill },
      agent: a.name,
      maxIterations: 20,
      emit: (e) => {
        if (e.type === "answer") answer = e.text;
        if (e.type === "error") err = e.message;
        emit(e);
      },
      askPermission: (t, i) => deps.askPermission(t, i, a.name),
    });
    return answer || (err ? `error: subagent failed: ${err}` : "(subagent returned nothing)");
  };

  const agentTool = tools.find((t) => t.name === "agent");
  return runLoop({
    host: cfg.ollamaHost,
    model: cfg.model,
    numCtx: cfg.numCtx,
    think: thinkFor(cfg.model),
    messages: history,
    tools,
    toolDescriptions: agentTool ? { agent: agentToolDescription(agentTool.description, agents) } : undefined,
    ctx: { cwd, signal, readSkill, runSubagent },
    emit,
    askPermission: (t, i) => deps.askPermission(t, i),
  });
}

export function estimateTokens(history: ChatMessage[]): number {
  return Math.ceil(history.reduce((n, m) => n + m.content.length + 16, 0) / 4);
}

export const COMPACT_PROMPT =
  "Summarize this conversation so far for your own future reference: the user's goals, decisions made, files touched, and what is still open. Be dense, under 250 words. No tool calls.";
