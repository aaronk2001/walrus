import { createStore } from "zustand/vanilla";
import type { AgentEvent, ChatMessage, PermissionDecision, Tool } from "./agent/types";
import { createContextVariant, listModels, loadedModels, modelCapabilities, pullModel, warmModel, type ModelInfo } from "./agent/ollama";
import { syncToOpenCode, variantName, VARIANT_CTX, type SyncResult } from "./opencode";
import { discoverAgents, discoverSkills, readBody, type Agent, type Skill } from "./catalog";
import { loadConfig, saveConfig, type Config, type Mode } from "./config";
import { COMMANDS, parseCommand } from "./commands";
import { COMPACT_PROMPT, estimateTokens, runTurn } from "./session";
import { todoStore } from "./agent/tools/todo";
import { runLoop } from "./agent/loop";
import { indexSkills } from "./router";
import { connect, discoverServers, type Connection, type ServerSpec } from "./mcp";
import { discoverCommands, expandCommand, type UserCommand } from "./userCommands";
import { expandMentions } from "./attachments";
import {
  appendPromptHistory,
  listSessions,
  loadPromptHistory,
  loadSession,
  newSessionId,
  saveSession,
  type SessionMeta,
} from "./sessions";

export type Item =
  | { id: number; kind: "banner" }
  | { id: number; kind: "user"; text: string; files?: string[] }
  | { id: number; kind: "skills"; names: string[]; routed: boolean }
  | { id: number; kind: "assistant"; text: string; agent?: string }
  | { id: number; kind: "tool"; tool: string; input: Record<string, unknown>; result: string; ok: boolean; agent?: string }
  | { id: number; kind: "info"; text: string }
  | { id: number; kind: "error"; text: string };

export type HubTab = "models" | "skills" | "agents" | "tools" | "mcp";

export interface ModelRow extends ModelInfo {
  caps: string[] | null;
  loaded: boolean;
}

export interface McpRow {
  spec: ServerSpec;
  status: "off" | "connecting" | "on" | "error";
  error?: string;
  tools: number;
}

export interface PermissionRequest {
  tool: Tool;
  input: Record<string, unknown>;
  agent?: string;
  resolve: (d: PermissionDecision) => void;
}

export interface State {
  cfg: Config;
  cwd: string;
  skills: Skill[];
  agents: Agent[];
  commands: UserCommand[];
  models: ModelRow[];
  mcp: McpRow[];
  ollamaError: string | null;
  items: Item[];
  epoch: number;
  live: string;
  thinking: string;
  running: boolean;
  currentTool: { tool: string; input: Record<string, unknown>; agent?: string } | null;
  activeAgent: string | null;
  ctxTokens: number;
  permission: PermissionRequest | null;
  view: "chat" | "hub" | "resume";
  hubTab: HubTab;
  pull: { model: string; status: string; pct: number } | null;
  warming: string | null;
  busyWith: string | null;
  sessions: SessionMeta[];
  inputHistory: string[];
  // what was typed when a permission prompt or the hub took the input's place
  draft: string;
  exitRequested: boolean;
}

let nextId = 1;
const id = () => nextId++;
let history: ChatMessage[] = [];
let abort: AbortController | null = null;
let sessionId: string | null = null;
let sessionCreated = "";
let lastActivity = 0;
const sessionAllow = new Set<string>();
const connections = new Map<string, Connection>();
// Config values replaced by CLI flags (-m, --yolo) for this run. Saving writes these back
// instead of the flag values, until the user changes that setting themselves.
let shadowed: Partial<Config> = {};

export const store = createStore<State>(() => ({
  cfg: loadConfig(),
  cwd: process.cwd(),
  skills: [],
  agents: [],
  commands: [],
  models: [],
  mcp: [],
  ollamaError: null,
  items: [{ id: id(), kind: "banner" }],
  epoch: 0,
  live: "",
  thinking: "",
  running: false,
  currentTool: null,
  activeAgent: null,
  ctxTokens: 0,
  permission: null,
  view: "chat",
  hubTab: "models",
  pull: null,
  warming: null,
  busyWith: null,
  sessions: [],
  inputHistory: [],
  draft: "",
  exitRequested: false,
}));

const set = store.setState;
const get = store.getState;

type NewItem = Item extends infer I ? (I extends Item ? Omit<I, "id"> : never) : never;

export const push = (item: NewItem) => set((s) => ({ items: [...s.items, { ...item, id: id() } as Item] }));
const info = (text: string) => push({ kind: "info", text });
const error = (text: string) => push({ kind: "error", text });

function updateCfg(patch: Partial<Config>) {
  const cfg = { ...get().cfg, ...patch };
  for (const key of Object.keys(patch)) delete shadowed[key as keyof Config];
  saveConfig({ ...cfg, ...shadowed });
  set({ cfg });
}

// Applies settings for this run only; they are never written to config.json.
export function applyFlags(flags: Partial<Config>) {
  const { cfg } = get();
  for (const key of Object.keys(flags) as Array<keyof Config>) {
    if (!(key in shadowed)) shadowed = { ...shadowed, [key]: cfg[key] };
  }
  set({ cfg: { ...cfg, ...flags } });
}

const notInstalled = (name: string) =>
  `No installed model "${name}". Installed: ${get().models.map((m) => m.name).join(", ")}`;

export function reloadCatalog() {
  const { cfg, models } = get();
  const cwd = get().cwd;
  set({
    skills: discoverSkills(cfg, cwd),
    agents: discoverAgents(
      cfg,
      models.map((m) => m.name),
      cwd,
    ),
    commands: discoverCommands(cwd),
  });
}

export async function refreshModels() {
  const { cfg } = get();
  try {
    const [list, loaded] = await Promise.all([listModels(cfg.ollamaHost), loadedModels(cfg.ollamaHost)]);
    const prev = new Map(get().models.map((m) => [m.name, m.caps]));
    set({
      ollamaError: null,
      models: list.map((m) => ({ ...m, caps: prev.get(m.name) ?? null, loaded: loaded.includes(m.name) })),
    });
    await Promise.all(
      list
        .filter((m) => prev.get(m.name) == null)
        .map((m) =>
          modelCapabilities(cfg.ollamaHost, m.name).then((caps) =>
            set((s) => ({ models: s.models.map((r) => (r.name === m.name ? { ...r, caps } : r)) })),
          ),
        ),
    );
  } catch {
    set({ ollamaError: `Ollama not reachable at ${cfg.ollamaHost} — start it with \`ollama serve\`` });
  }
}

export function warm() {
  const { cfg } = get();
  const model = cfg.model;
  set({ warming: model });
  warmModel(cfg.ollamaHost, model, cfg.numCtx)
    .catch((e) => error(`Could not load ${model}: ${(e as Error).message}`))
    .finally(() => {
      if (get().warming === model) set({ warming: null });
      void refreshModels();
    });
}

// ---- MCP ----

export const mcpTools = (): Tool[] => [...connections.values()].flatMap((c) => c.tools);

function setMcpRow(name: string, patch: Partial<McpRow>) {
  set((s) => ({ mcp: s.mcp.map((r) => (r.spec.name === name ? { ...r, ...patch } : r)) }));
}

async function startServer(spec: ServerSpec) {
  setMcpRow(spec.name, { status: "connecting", error: undefined });
  try {
    const conn = await connect(spec);
    connections.set(spec.name, conn);
    setMcpRow(spec.name, { status: "on", tools: conn.tools.length });
  } catch (e) {
    setMcpRow(spec.name, { status: "error", error: (e as Error).message });
  }
}

async function stopServer(name: string) {
  const c = connections.get(name);
  connections.delete(name);
  setMcpRow(name, { status: "off", tools: 0 });
  await c?.client.close().catch(() => {});
}

export function toggleMcp(name: string) {
  const row = get().mcp.find((r) => r.spec.name === name);
  if (!row) return;
  const on = row.status === "off" || row.status === "error";
  updateCfg({ mcp: { ...get().cfg.mcp, [name]: on } });
  if (on) void startServer(row.spec);
  else void stopServer(name);
}

export async function shutdown() {
  await Promise.all([...connections.keys()].map(stopServer));
}

// ---- lifecycle ----

// `model` is the -m flag: used for this run if installed, otherwise reported.
export async function init(opts: { model?: string; waitForMcp?: boolean } = {}) {
  const specs = discoverServers(get().cwd);
  set({
    inputHistory: loadPromptHistory(),
    mcp: specs.map((spec) => ({ spec, status: "off", tools: 0 })),
  });
  await refreshModels();
  reloadCatalog();
  const { ollamaError, models } = get();
  const installed = (name: string) => models.some((m) => m.name === name);
  if (ollamaError) error(ollamaError);
  else {
    if (opts.model) {
      if (installed(opts.model)) applyFlags({ model: opts.model });
      else error(notInstalled(opts.model));
    }
    const { cfg } = get();
    if (!installed(cfg.model)) {
      const fallback = models.find((m) => !/embed/i.test(m.name));
      if (fallback) {
        info(`Model ${cfg.model} is not installed — using ${fallback.name}. Change it in /hub.`);
        updateCfg({ model: fallback.name });
      } else error("No models installed. Open /hub → Models → + Pull a model (e.g. qwen3:1.7b).");
    }
  }
  const { cfg } = get();
  if (!get().ollamaError && installed(cfg.model)) warm();
  if (!get().ollamaError && cfg.embedModel && models.some((m) => m.name.split(":")[0] === cfg.embedModel.split(":")[0]))
    void indexSkills(cfg, get().skills).catch(() => {});
  const starting = specs.filter((s) => cfg.mcp[s.name]).map(startServer);
  if (opts.waitForMcp) await Promise.all(starting);
}

function flushLive(agent?: string) {
  const text = get().live.trim();
  if (text) push({ kind: "assistant", text, agent });
  set({ live: "", thinking: "" });
}

function onEvent(e: AgentEvent) {
  lastActivity = Date.now();
  if (get().busyWith) set({ busyWith: null });
  switch (e.type) {
    case "thinking":
      set((s) => ({ thinking: (s.thinking + e.text).slice(-400) }));
      break;
    case "token":
      set((s) => ({ live: s.live + e.text, activeAgent: e.agent ?? null }));
      break;
    case "reset":
      set({ live: "" });
      break;
    case "skills":
      if (e.names.length) push({ kind: "skills", names: e.names, routed: e.routed });
      break;
    case "tool_start":
      flushLive(e.agent);
      set({ currentTool: { tool: e.tool, input: e.input, agent: e.agent }, activeAgent: e.agent ?? null });
      if (e.tool === "agent") set({ activeAgent: String(e.input.name ?? "") });
      break;
    case "tool_end":
      push({ kind: "tool", tool: e.tool, input: get().currentTool?.input ?? {}, result: e.result, ok: e.ok, agent: e.agent });
      set({ currentTool: null, activeAgent: e.tool === "agent" ? null : get().activeAgent });
      break;
    case "usage":
      if (!e.agent) set({ ctxTokens: e.promptTokens + e.outputTokens });
      break;
    case "answer":
      flushLive(e.agent);
      break;
    case "error":
      flushLive(e.agent);
      if (e.message === "interrupted") info("Interrupted.");
      else error(e.agent ? `[${e.agent}] ${e.message}` : e.message);
      break;
  }
}

const allowKey = (tool: Tool, input: Record<string, unknown>) =>
  tool.scope ? `${tool.name} ${tool.scope(input)}` : tool.name;

function askPermission(tool: Tool, input: Record<string, unknown>, agent?: string): Promise<PermissionDecision> {
  if (get().cfg.mode === "auto" || sessionAllow.has(allowKey(tool, input))) return Promise.resolve("yes");
  return new Promise((resolve) => set({ permission: { tool, input, agent, resolve } }));
}

export function answerPermission(d: PermissionDecision) {
  const p = get().permission;
  if (!p) return;
  if (d === "always") sessionAllow.add(allowKey(p.tool, p.input));
  set({ permission: null });
  p.resolve(d);
}

// While waiting on Ollama with no output, check whether another model is holding it.
function watchBusy(): () => void {
  const timer = setInterval(async () => {
    const s = get();
    if (!s.running || s.currentTool || s.permission || Date.now() - lastActivity < 4000) return;
    const loaded = await loadedModels(s.cfg.ollamaHost);
    const others = loaded.filter((m) => m !== s.cfg.model && !m.startsWith(s.cfg.embedModel));
    const busy = !loaded.includes(s.cfg.model) && others.length ? others.join(", ") : null;
    if (get().running && Date.now() - lastActivity >= 4000) set({ busyWith: busy });
  }, 2000);
  return () => clearInterval(timer);
}

async function run(prompt: string, query = prompt) {
  abort = new AbortController();
  lastActivity = Date.now();
  set({ running: true, live: "", thinking: "", busyWith: null });
  const stopWatch = watchBusy();
  try {
    const { cfg, cwd, skills, agents } = get();
    history = await runTurn(
      { cfg, cwd, skills, agents, caps: capsMap(), extraTools: mcpTools(), emit: onEvent, askPermission },
      history,
      prompt,
      abort.signal,
      query,
    );
    if (!get().ctxTokens) set({ ctxTokens: estimateTokens(history) });
  } finally {
    stopWatch();
    abort = null;
    set({ running: false, currentTool: null, activeAgent: null, live: "", thinking: "", busyWith: null });
  }
  persistSession();
  if (get().ctxTokens > get().cfg.numCtx * 0.8) {
    info(`Context ${Math.round((get().ctxTokens / get().cfg.numCtx) * 100)}% full — compacting automatically.`);
    await compact();
  }
}

export const capsMap = () => Object.fromEntries(get().models.map((m) => [m.name, m.caps ?? []]));

export function toggleThink() {
  updateCfg({ think: !get().cfg.think });
  info(`Thinking → ${get().cfg.think ? "on (slower, smarter)" : "off (fast)"}`);
}

export function interrupt() {
  const p = get().permission;
  if (p) answerPermission("no");
  abort?.abort();
}

export function setModel(name: string) {
  if (!get().models.some((m) => m.name === name)) {
    error(notInstalled(name));
    return;
  }
  updateCfg({ model: name });
  reloadCatalog();
  resetSystemPrompt();
  info(`Model → ${name}`);
  warm();
}

export function toggleMode() {
  const mode: Mode = get().cfg.mode === "ask" ? "auto" : "ask";
  updateCfg({ mode });
}

export function toggleSkill(name: string) {
  const s = get().skills.find((x) => x.name === name);
  if (!s) return;
  updateCfg({ skills: { ...get().cfg.skills, [name]: !s.enabled } });
  reloadCatalog();
}

export function toggleAgent(name: string) {
  const a = get().agents.find((x) => x.name === name);
  if (!a) return;
  updateCfg({ agents: { ...get().cfg.agents, [name]: !a.enabled } });
  reloadCatalog();
}

export function toggleTool(name: string) {
  const on = get().cfg.tools[name] !== false;
  updateCfg({ tools: { ...get().cfg.tools, [name]: !on } });
  resetSystemPrompt();
}

// The system prompt mentions available tools; rebuild it on the next turn.
function resetSystemPrompt() {
  if (history[0]?.role === "system") history.shift();
}

export function openHub(tab?: HubTab) {
  refreshModels();
  set({ view: "hub", ...(tab ? { hubTab: tab } : {}) });
}

export const closeHub = () => set({ view: "chat" });
export const setHubTab = (hubTab: HubTab) => set({ hubTab });

export async function startPull(model: string) {
  const { cfg } = get();
  set({ pull: { model, status: "starting", pct: 0 } });
  try {
    for await (const p of pullModel(cfg.ollamaHost, model)) {
      if (p.error) throw new Error(p.error);
      const pct = p.total ? Math.round(((p.completed ?? 0) / p.total) * 100) : get().pull?.pct ?? 0;
      set({ pull: { model, status: p.status, pct } });
    }
    info(`Pulled ${model}.`);
    await refreshModels();
  } catch (e) {
    error(`Pull failed for ${model}: ${(e as Error).message}`);
  } finally {
    set({ pull: null });
  }
}

// ---- OpenCode ----

// Models worth exposing to OpenCode: the Walrus model plus the best small coder, if installed.
export function opencodeModels(extra: string[] = []): string[] {
  const { cfg, models } = get();
  const usable = (n: string) => {
    const m = models.find((x) => x.name === n);
    return !!m && !/embed/i.test(n) && !n.endsWith("-16k") && (m.caps?.includes("tools") ?? true);
  };
  return [...new Set([cfg.model, "qwen2.5-coder:3b", ...extra])].filter(usable);
}

export async function syncOpenCode(extra: string[] = []): Promise<SyncResult> {
  const { cfg, models } = get();
  const chosen = opencodeModels(extra);
  for (const m of chosen)
    if (!models.some((x) => x.name === variantName(m))) await createContextVariant(cfg.ollamaHost, m, variantName(m), VARIANT_CTX);
  const s = get();
  const result = syncToOpenCode({
    ollamaHost: cfg.ollamaHost,
    models: chosen,
    servers: s.mcp.map((r) => r.spec),
    mcpEnabled: cfg.mcp,
    agents: s.agents,
    commands: s.commands,
    skills: s.skills,
  });
  await refreshModels();
  return result;
}

export function describeSync(r: SyncResult): string {
  const list = (label: string, xs: string[]) => (xs.length ? `  ${label} (${xs.length}): ${xs.join(", ")}` : `  ${label}: none`);
  return [
    `Synced to OpenCode → ${r.configPath}`,
    list("models", r.models),
    list("mcp servers", r.mcp),
    list("agents", r.agents),
    list("commands", r.commands),
    list("skills copied", r.skills),
    "  Claude skills: OpenCode reads ~/.claude/skills itself",
    ...(r.skipped.length ? [`  left alone (yours): ${r.skipped.join(", ")}`] : []),
    `In OpenCode, pick a model under "Ollama (local, via Walrus)". Run /opencode again after changing things here.`,
  ].join("\n");
}

async function opencodeCommand(args: string) {
  info("Syncing to OpenCode…");
  try {
    info(describeSync(await syncOpenCode(args.split(/\s+/).filter(Boolean))));
  } catch (e) {
    error(`OpenCode sync failed: ${(e as Error).message}`);
  }
}

// ---- sessions ----

function persistSession() {
  const firstUser = get().items.find((i): i is Extract<Item, { kind: "user" }> => i.kind === "user");
  if (!firstUser) return;
  const now = new Date().toISOString();
  if (!sessionId) {
    sessionId = newSessionId();
    sessionCreated = now;
  }
  saveSession({
    id: sessionId,
    cwd: get().cwd,
    model: get().cfg.model,
    title: firstUser.text.slice(0, 100),
    created: sessionCreated,
    updated: now,
    history,
    items: get().items.filter((i) => i.kind !== "banner"),
  });
}

function resetScreen(items: Item[]) {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  set((s) => ({ items: [{ id: id(), kind: "banner" }, ...items], epoch: s.epoch + 1 }));
}

export function clearConversation() {
  history = [];
  sessionId = null;
  todoStore.setState({ todos: [] });
  resetScreen([]);
  set({ ctxTokens: 0 });
}

export function openResume() {
  const sessions = listSessions(get().cwd);
  if (!sessions.length) return info("No saved sessions yet.");
  set({ view: "resume", sessions });
}

export const closeResume = () => set({ view: "chat" });

export function resumeSession(sid: string) {
  const s = loadSession<Item>(sid);
  set({ view: "chat" });
  if (!s) return error(`Session ${sid} not found.`);
  history = s.history;
  sessionId = s.id;
  sessionCreated = s.created;
  todoStore.setState({ todos: [] });
  resetScreen(s.items.map((i) => ({ ...i, id: id() })));
  set({ ctxTokens: estimateTokens(history) });
  info(`Resumed "${s.title}" — ${s.history.filter((m) => m.role === "user").length} earlier turns.`);
}

export function continueLast(): boolean {
  const norm = (p: string) => p.replaceAll("\\", "/").toLowerCase();
  const last = listSessions(get().cwd).find((s) => norm(s.cwd) === norm(get().cwd));
  if (!last) return false;
  resumeSession(last.id);
  return true;
}

async function compact() {
  if (history.length < 3) return info("Nothing to compact yet.");
  abort = new AbortController();
  set({ running: true });
  let summary = "";
  const { cfg } = get();
  try {
    await runLoop({
      host: cfg.ollamaHost,
      model: cfg.model,
      numCtx: cfg.numCtx,
      messages: [...history, { role: "user", content: COMPACT_PROMPT }],
      tools: [],
      ctx: { cwd: get().cwd, signal: abort.signal },
      emit: (e) => {
        if (e.type === "answer") summary = e.text;
        if (e.type === "error") error(e.message);
      },
      askPermission: async () => "no",
    });
  } finally {
    abort = null;
    set({ running: false });
  }
  if (!summary) return;
  const sys = history[0]?.role === "system" ? [history[0]] : [];
  history = [...sys, { role: "user", content: `Summary of our earlier conversation:\n${summary}` }, { role: "assistant", content: "Got it." }];
  set({ ctxTokens: estimateTokens(history) });
  info(`Compacted conversation:\n${summary}`);
  persistSession();
}

function help() {
  const rows: Array<[string, string]> = [
    ...COMMANDS.map((c): [string, string] => [`/${`${c.name} ${c.args ?? ""}`.trimEnd()}`, c.description]),
    ["/<skill> [request]", "Run a skill directly"],
    ...get().commands.map((c): [string, string] => [`/${`${c.name} ${c.argHint}`.trimEnd()}`, `${c.description} (${c.source})`]),
  ];
  const pad = Math.min(28, Math.max(...rows.map(([n]) => n.length)) + 2);
  info(
    [
      "Commands",
      ...rows.map(([n, d]) => `  ${n.padEnd(pad)} ${d}`),
      "",
      "Keys",
      "  enter send · ctrl+j or \\+enter newline · @ attach file · esc interrupt · shift+tab ask/auto",
      "  ↑/↓ history · tab complete · ctrl+c twice quit",
    ].join("\n"),
  );
}

function sendPrompt(display: string, prompt = display) {
  const { prompt: expanded, files } = expandMentions(prompt, get().cwd);
  push({ kind: "user", text: display, ...(files.length ? { files } : {}) });
  return run(expanded, display);
}

export async function submit(raw: string) {
  const text = raw.trim();
  if (!text || get().running) return;
  if (get().inputHistory.at(-1) !== text) {
    set((s) => ({ inputHistory: [...s.inputHistory, text].slice(-200) }));
    appendPromptHistory(text);
  }
  const cmd = parseCommand(text);
  if (!cmd) return sendPrompt(text);
  switch (cmd.name) {
    case "help":
      return help();
    case "hub":
      return openHub();
    case "model":
      return cmd.args ? setModel(cmd.args) : openHub("models");
    case "models":
      return openHub("models");
    case "skills":
      return openHub("skills");
    case "agents":
      return openHub("agents");
    case "tools":
      return openHub("tools");
    case "mcp":
      return openHub("mcp");
    case "mode":
      toggleMode();
      return info(`Permission mode → ${get().cfg.mode}`);
    case "compact":
      return compact();
    case "think":
      return toggleThink();
    case "resume":
      return openResume();
    case "opencode":
      return opencodeCommand(cmd.args);
    case "clear":
      return clearConversation();
    case "exit":
    case "quit":
      return set({ exitRequested: true });
  }
  const userCmd = get().commands.find((c) => c.name === cmd.name);
  if (userCmd) return sendPrompt(text, expandCommand(userCmd, cmd.args));
  const skill = get().skills.find((s) => s.name.toLowerCase() === cmd.name);
  if (skill) {
    const body = readBody(skill.path);
    return sendPrompt(
      text,
      `Follow the "${skill.name}" skill below for this request.\n\n<skill>\n${body}\n</skill>\n\nRequest: ${cmd.args || "(no extra details — ask me what I need if the skill requires input)"}`,
    );
  }
  error(`Unknown command /${cmd.name}. Type /help.`);
}
