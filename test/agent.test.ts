import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, ChatMessage } from "../src/agent/types";

// Isolated homes so tests never touch the real ~/.walrus or ~/.claude
const root = mkdtempSync(join(tmpdir(), "walrus-home-"));
process.env.WALRUS_HOME = join(root, "walrus");
process.env.CLAUDE_HOME = join(root, "claude");
process.env.OPENCODE_CONFIG_DIR = join(root, "opencode");
process.env.AGENTS_SKILLS_DIR = join(root, "agents-skills");

const { discoverSkills, discoverAgents, mapAgentTools } = await import("../src/catalog");
const { DEFAULTS } = await import("../src/config");
const { runTurn, buildSystemPrompt, activeTools } = await import("../src/session");

function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

beforeAll(() => {
  write(join(root, "claude", "settings.json"), JSON.stringify({ skillOverrides: { "off-skill": "off" } }));
  write(join(root, "claude", "skills", "on-skill", "SKILL.md"), "---\nname: on-skill\ndescription: Does on things\n---\nON BODY");
  write(join(root, "claude", "skills", "off-skill", "SKILL.md"), "---\nname: off-skill\ndescription: Off\n---\nOFF");
  write(join(root, "walrus", "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: Walrus own\n---\nMINE BODY");
  write(join(root, "claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\ntools: Read, Grep\nmodel: sonnet\n---\nYou review code.");
});

describe("catalog", () => {
  test("skills respect Claude overrides and Walrus config", () => {
    const skills = discoverSkills(DEFAULTS);
    expect(skills.map((s) => [s.name, s.source, s.enabled])).toEqual([
      ["mine", "walrus", true],
      ["off-skill", "claude", false],
      ["on-skill", "claude", true],
    ]);
    const cfg = { ...DEFAULTS, skills: { "off-skill": true, "on-skill": false } };
    expect(discoverSkills(cfg).filter((s) => s.enabled).map((s) => s.name)).toEqual(["mine", "off-skill"]);
  });

  test("agents map tools and ignore non-Ollama models", () => {
    const [a] = discoverAgents(DEFAULTS, ["qwen3:1.7b"]);
    expect(a).toMatchObject({ name: "reviewer", tools: ["read_file", "grep"], model: null, enabled: true });
    expect(mapAgentTools("*")).toBeNull();
    expect(mapAgentTools(undefined)).toBeNull();
  });

  test("system prompt is stable and skill-free", () => {
    const skills = discoverSkills(DEFAULTS);
    const agents = discoverAgents(DEFAULTS);
    const p = buildSystemPrompt({ cwd: root, tools: activeTools(DEFAULTS, skills, agents) });
    expect(p).toContain("<skills>");
    expect(p).not.toContain("on-skill");
  });

  test("disabled tools are removed", () => {
    const names = activeTools({ ...DEFAULTS, tools: { bash: false } }, [], []).map((t) => t.name);
    expect(names).not.toContain("bash");
    expect(names).not.toContain("skill");
    expect(names).not.toContain("agent");
  });
});

// Fake Ollama: each /api/chat call pops the next scripted reply.
type Reply = {
  content?: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  error?: string; // sent after the content, instead of the final chunks
};
let script: Reply[] = [];
const requests: Array<{ model: string; messages: ChatMessage[]; tools?: unknown[]; think?: boolean }> = [];
let server: ReturnType<typeof Bun.serve>;
let embedCalls = 0;

// Deterministic stand-in for nomic-embed-text: hashed bag of words.
function bagOfWords(text: string): number[] {
  const v = new Array(64).fill(0);
  for (const w of text.replace(/^search_(query|document): /, "").toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 64;
    v[h] += 1;
  }
  return v;
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as (typeof requests)[number] & { input: string[] };
      if (new URL(req.url).pathname === "/api/embed") {
        embedCalls++;
        return Response.json({ embeddings: body.input.map(bagOfWords) });
      }
      requests.push(body);
      const r = script.shift() ?? { content: "(script empty)" };
      const words = (r.content ?? "").match(/.{1,5}/gs) ?? [];
      const lines = [
        ...words.map((w) => JSON.stringify({ message: { role: "assistant", content: w }, done: false })),
        ...(r.error
          ? [JSON.stringify({ error: r.error })]
          : [
              JSON.stringify({ message: { role: "assistant", content: "", tool_calls: r.tool_calls }, done: false }),
              JSON.stringify({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 100, eval_count: 20 }),
            ]),
      ];
      return new Response(lines.join("\n") + "\n");
    },
  });
});
afterAll(() => server.stop(true));

function deps(over: Partial<Parameters<typeof runTurn>[0]> = {}) {
  const events: AgentEvent[] = [];
  const skills = discoverSkills(DEFAULTS);
  const agents = discoverAgents(DEFAULTS);
  return {
    events,
    d: {
      cfg: { ...DEFAULTS, ollamaHost: `http://localhost:${server.port}`, model: "fake" },
      cwd: root,
      skills,
      agents,
      caps: { fake: ["completion", "tools", "thinking"] },
      emit: (e: AgentEvent) => events.push(e),
      askPermission: async () => "yes" as const,
      ...over,
    },
  };
}

describe("skill routing", () => {
  test("only matching skills ride on the user message", async () => {
    script = [{ content: "ok" }];
    const { events, d } = deps();
    const history: ChatMessage[] = [];
    await runTurn(d, history, "mine: walrus own", new AbortController().signal);
    const user = history.find((m) => m.role === "user")!.content;
    expect(user).toContain("<skills>");
    expect(user).toContain("- mine: Walrus own");
    expect(user).not.toContain("on-skill");
    expect(events.find((e) => e.type === "skills")).toEqual({ type: "skills", names: ["mine"], routed: true });
  });

  test("embedding cache avoids re-embedding skills", async () => {
    script = [{ content: "ok" }];
    const before = embedCalls;
    const { d } = deps();
    await runTurn(d, [], "walrus own", new AbortController().signal);
    expect(embedCalls - before).toBe(1); // just the query
  });

  test("falls back to listing all enabled skills when embedding is off", async () => {
    script = [{ content: "ok" }];
    const { events, d } = deps();
    d.cfg = { ...d.cfg, embedModel: "" };
    await runTurn(d, [], "anything", new AbortController().signal);
    expect(events.find((e) => e.type === "skills")).toMatchObject({ names: ["mine", "on-skill"], routed: false });
  });
});

describe("agent loop", () => {
  test("tool call then answer, think flag sent for thinking models", async () => {
    requests.length = 0;
    script = [
      { tool_calls: [{ function: { name: "list_dir", arguments: { path: "claude" } } }] },
      { content: "There are 2 things." },
    ];
    const { events, d } = deps();
    const history: ChatMessage[] = [];
    await runTurn(d, history, "what is here?", new AbortController().signal);
    expect(events.find((e) => e.type === "tool_start")).toMatchObject({ tool: "list_dir" });
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ ok: true });
    expect(events.at(-1)).toEqual({ type: "answer", text: "There are 2 things.", agent: undefined });
    expect(events.find((e) => e.type === "usage")).toMatchObject({ promptTokens: 100, outputTokens: 20 });
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(history[1]!.content.startsWith("what is here?")).toBe(true);
    expect(history[3]!.content).toContain("settings.json");
    expect(requests[0]!.think).toBe(false);
  });

  test("permission denial is reported to the model, file untouched", async () => {
    script = [
      { tool_calls: [{ function: { name: "write_file", arguments: { path: "x.txt", content: "hi" } } }] },
      { content: "ok, not writing" },
    ];
    const { events, d } = deps({ askPermission: async () => "no" });
    const history: ChatMessage[] = [];
    await runTurn(d, history, "write x", new AbortController().signal);
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ ok: false });
    expect(history[3]!.content).toContain("denied");
    expect(await Bun.file(join(root, "x.txt")).exists()).toBe(false);
  });

  test("skill tool returns the body", async () => {
    script = [{ tool_calls: [{ function: { name: "skill", arguments: { name: "mine" } } }] }, { content: "done" }];
    const { d } = deps();
    const history: ChatMessage[] = [];
    await runTurn(d, history, "use my skill", new AbortController().signal);
    expect(history[3]!.content).toContain("MINE BODY");
  });

  test("subagent runs with its own prompt and mapped tools", async () => {
    requests.length = 0;
    script = [
      { tool_calls: [{ function: { name: "agent", arguments: { name: "reviewer", task: "review a.ts" } } }] },
      { content: "LGTM from reviewer" }, // subagent's answer
      { content: "Reviewer says LGTM." }, // parent's final answer
    ];
    const { events, d } = deps();
    const history: ChatMessage[] = [];
    await runTurn(d, history, "get a review", new AbortController().signal);
    const sub = requests[1]!;
    expect(sub.messages[0]!.content).toContain("You review code.");
    expect((sub.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort()).toEqual(["grep", "read_file", "skill"]);
    expect(events.some((e) => e.type === "answer" && e.agent === "reviewer")).toBe(true);
    expect(history[3]!.content).toBe("LGTM from reviewer");
  });

  test("stray </think> content is reclassified, not answered", async () => {
    script = [{ content: "hmm counting</think>\n\n6" }];
    const { events, d } = deps();
    await runTurn(d, [], "count", new AbortController().signal);
    expect(events.some((e) => e.type === "reset")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "answer", text: "6" });
  });

  test("misspelled tool names and string args are repaired", async () => {
    script = [
      { tool_calls: [{ function: { name: "functions.listDir", arguments: '{"path":"claude"}' as unknown as Record<string, unknown> } }] },
      { content: "done" },
    ];
    const { events, d } = deps();
    const history: ChatMessage[] = [];
    await runTurn(d, history, "x", new AbortController().signal);
    expect(events.find((e) => e.type === "tool_start")).toMatchObject({ tool: "list_dir", input: { path: "claude" } });
    expect(history[3]!.content).toContain("settings.json");
  });

  test("a tool call printed as bare JSON is run", async () => {
    script = [{ content: '```json\n{"name": "list_dir", "arguments": {"path": "claude"}}\n```' }, { content: "done" }];
    const { events, d } = deps();
    const history: ChatMessage[] = [];
    await runTurn(d, history, "x", new AbortController().signal);
    expect(events.find((e) => e.type === "tool_start")).toMatchObject({ tool: "list_dir", input: { path: "claude" } });
    expect(events.at(-1)).toMatchObject({ type: "answer", text: "done" });
  });

  test("a broken printed tool call is sent back for a retry, not answered", async () => {
    script = [{ content: '{"name": "read_file", "arguments": {"path": "a.ts")}' }, { content: "ok" }];
    const { events, d } = deps();
    const history: ChatMessage[] = [];
    await runTurn(d, history, "x", new AbortController().signal);
    expect(history.some((m) => m.role === "user" && m.content.includes("not valid JSON"))).toBe(true);
    expect(events.filter((e) => e.type === "answer")).toEqual([{ type: "answer", text: "ok", agent: undefined }]);
  });

  test("missing required args produce a precise retry hint", async () => {
    script = [{ tool_calls: [{ function: { name: "read_file", arguments: {} } }] }, { content: "sorry" }];
    const { d } = deps();
    const history: ChatMessage[] = [];
    await runTurn(d, history, "x", new AbortController().signal);
    expect(history[3]!.content).toContain("missing required argument `path`");
    expect(history[3]!.content).toContain("read_file expects {path: string (required)");
  });

  test("unknown tool yields error result, loop continues", async () => {
    script = [{ tool_calls: [{ function: { name: "nope", arguments: {} } }] }, { content: "sorry" }];
    const { events, d } = deps();
    const history: ChatMessage[] = [];
    await runTurn(d, history, "x", new AbortController().signal);
    expect(history[3]!.content).toContain('unknown tool "nope"');
    expect(events.at(-1)).toMatchObject({ type: "answer", text: "sorry" });
  });

  test("models without tool support chat without tools", async () => {
    requests.length = 0;
    script = [{ content: "just chatting" }];
    const { events, d } = deps({ caps: { fake: ["completion"] } });
    const history: ChatMessage[] = [];
    await runTurn(d, history, "hi", new AbortController().signal);
    expect(requests[0]!.tools).toBeUndefined();
    expect(history[0]!.content).toContain("This model has no tools");
    expect(events.at(-1)).toMatchObject({ type: "answer", text: "just chatting" });
  });

  test("without tools, a printed <tool_call> is just text", async () => {
    requests.length = 0;
    const text = '<tool_call>{"name":"bash","arguments":{"cmd":"ls"}}</tool_call>';
    script = [{ content: text }];
    const { events, d } = deps({ caps: { fake: ["completion"] } });
    await runTurn(d, [], "hi", new AbortController().signal);
    expect(requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "answer", text });
  });

  test("an error mid-reply fails the turn instead of answering with half a reply", async () => {
    script = [{ content: "Here is the first half", error: "model runner has unexpectedly stopped" }];
    const { events, d } = deps();
    const history: ChatMessage[] = [];
    await runTurn(d, history, "x", new AbortController().signal);
    expect(events.some((e) => e.type === "answer")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "error", message: "Ollama: model runner has unexpectedly stopped", agent: undefined });
    expect(history.map((m) => m.role)).toEqual(["system", "user"]);
  });

  test("abort stops the turn", async () => {
    script = [{ content: "never" }];
    const ac = new AbortController();
    ac.abort();
    const { events, d } = deps();
    await runTurn(d, [], "x", ac.signal);
    expect(events.at(-1)).toMatchObject({ type: "error", message: "interrupted" });
  });
});
