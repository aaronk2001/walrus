import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";

const root = mkdtempSync(join(tmpdir(), "walrus-ui-"));
process.env.WALRUS_HOME = join(root, "walrus");
process.env.CLAUDE_HOME = join(root, "claude");
process.env.OPENCODE_CONFIG_DIR = join(root, "opencode");
process.env.AGENTS_SKILLS_DIR = join(root, "agents-skills");
process.env.CLAUDE_JSON = join(root, "claude.json");
mkdirSync(join(root, "walrus"), { recursive: true });
writeFileSync(
  join(root, "walrus", "mcp.json"),
  JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [join(import.meta.dir, "fixtures", "echo-mcp.ts")] } } }),
);
mkdirSync(join(root, "claude", "skills", "brainstorm"), { recursive: true });
writeFileSync(join(root, "claude", "skills", "brainstorm", "SKILL.md"), "---\nname: brainstorm\ndescription: Ideas\n---\nBRAIN");

type Reply = string | { tool: string; args: Record<string, unknown> };
let chatReplies: Reply[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/tags")
      return Response.json({
        models: [
          { name: "qwen3:1.7b", size: 1.4e9, details: { parameter_size: "2.0B", quantization_level: "Q4_K_M" } },
          { name: "llama3.2:3b", size: 2e9, details: { parameter_size: "3.2B", quantization_level: "Q4_K_M" } },
        ],
      });
    if (url.pathname === "/api/ps") return Response.json({ models: [] });
    if (url.pathname === "/api/show") return Response.json({ capabilities: ["completion", "tools"] });
    if (url.pathname === "/api/generate") return Response.json({ done: true });
    if (url.pathname === "/page") return new Response("<p>page text</p>", { headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/chat") {
      const r = chatReplies.shift() ?? "ok";
      const message =
        typeof r === "string"
          ? { role: "assistant", content: r }
          : { role: "assistant", content: "", tool_calls: [{ function: { name: r.tool, arguments: r.args } }] };
      return new Response(
        JSON.stringify({ message, done: false }) +
          "\n" +
          JSON.stringify({ message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 4096, eval_count: 10 }) +
          "\n",
      );
    }
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => server.stop(true));

const S = await import("../src/store");
// a test that unmounts mid-typing would otherwise hand its draft to the next one
afterEach(() => S.store.setState({ draft: "" }));
const { App } = await import("../src/ui/App");
const { Hub } = await import("../src/ui/Hub");
const { Banner } = await import("../src/ui/Banner");
const { Live } = await import("../src/ui/Live");
const { PROMPT_GRACE_MS } = await import("../src/ui/Permission");

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const strip = (s = "") => s.replace(/\x1b\[[0-9;]*m/g, "");
async function waitFor(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await tick(20);
  }
}

beforeAll(async () => {
  S.store.setState((s) => ({ cfg: { ...s.cfg, ollamaHost: `http://localhost:${server.port}`, model: "qwen3:1.7b" } }));
  await S.init();
});

describe("banner", () => {
  test("shows mascot and session info", () => {
    const { lastFrame } = render(<Banner model="qwen3:1.7b" cwd={root} skills={3} agents={2} ollamaOk />);
    const f = strip(lastFrame());
    expect(f).toContain("Walrus");
    expect(f).toContain("qwen3:1.7b");
    expect(f).toContain("3 skills · 2 agents");
    expect(f).toContain("▀");
  });
});

describe("layout", () => {
  // Yoga shrinks a short prefix beside unbreakable text, Ink still paints it, and the row overflows;
  // a full-width row makes the terminal wrap and Ink's redraws leave copies behind
  test("an answer with one long unbroken token stays inside its width", async () => {
    const { ItemView } = await import("../src/ui/Transcript");
    const { Box } = await import("ink");
    const text = '{"name":"todo_write","arguments":' + "x".repeat(420) + "}";
    const app = render(
      <Box width={103} flexDirection="column">
        <ItemView item={{ id: 1, kind: "assistant", text }} />
        <ItemView item={{ id: 2, kind: "user", text }} />
      </Box>,
    );
    const widths = strip(app.lastFrame()).split("\n").map((l) => Bun.stringWidth(l));
    expect(Math.max(...widths)).toBeLessThanOrEqual(103);
    app.unmount();
  });
});

describe("app", () => {
  test("chat turn renders answer and HUD context", async () => {
    chatReplies = ["Hello from **walrus**"];
    const app = render(<App skipInit />);
    await tick();
    expect(strip(app.lastFrame())).toContain("▌walrus");
    app.stdin.write("hi there");
    await tick();
    app.stdin.write("\r");
    await waitFor(() => !S.store.getState().running && S.store.getState().items.some((i) => i.kind === "assistant"));
    await tick();
    const f = strip(app.frames.join("\n"));
    expect(f).toContain("hi there");
    expect(f).toContain("Hello from walrus");
    expect(strip(app.lastFrame())).toContain("50%"); // 4106 / 8192
    app.unmount();
  });

  test("tool calls printed as text don't stay in the transcript", async () => {
    S.clearConversation();
    chatReplies = ['{"name": "list_dir", "arguments": {"path": "x")}', '{"name": "list_dir", "arguments": {"path": "."}}', "listed"];
    const app = render(<App skipInit />);
    await tick();
    app.stdin.write("look");
    await tick();
    app.stdin.write("\r");
    await waitFor(() => !S.store.getState().running && S.store.getState().items.some((i) => i.kind === "assistant"));
    await tick();
    const items = S.store.getState().items;
    expect(items.filter((i) => i.kind === "assistant").map((i) => (i as { text: string }).text)).toEqual(["listed"]);
    expect(items.some((i) => i.kind === "tool" && i.tool === "list_dir")).toBe(true);
    expect(strip(app.lastFrame())).not.toContain('"name"');
    app.unmount();
  });

  test("slash suggestions and /help", async () => {
    const app = render(<App skipInit />);
    await tick();
    app.stdin.write("/he");
    await tick();
    expect(strip(app.lastFrame())).toContain("/help");
    app.stdin.write("\r");
    await tick(60);
    expect(strip(app.frames.join("\n"))).toContain("/compact");
    app.unmount();
  });

  test("rapid keystrokes are not dropped", async () => {
    const app = render(<App skipInit />);
    await tick();
    for (const c of "/tools") app.stdin.write(c);
    app.stdin.write("\r");
    await tick(80);
    expect(S.store.getState().view).toBe("hub");
    expect(S.store.getState().hubTab).toBe("tools");
    S.closeHub();
    app.unmount();
  });

  test("/brainstorm runs a skill directly", async () => {
    chatReplies = ["skill ran"];
    const app = render(<App skipInit />);
    await tick();
    app.stdin.write("/brainstorm a CLI");
    await tick();
    app.stdin.write("\r");
    await waitFor(() => !S.store.getState().running && S.store.getState().items.some((i) => i.kind === "assistant" && i.text === "skill ran"));
    app.unmount();
  });

  test("shift+tab toggles permission mode", async () => {
    const app = render(<App skipInit />);
    await tick();
    const before = S.store.getState().cfg.mode;
    app.stdin.write("\x1b[Z");
    await tick();
    expect(S.store.getState().cfg.mode).not.toBe(before);
    expect(strip(app.lastFrame())).toContain(S.store.getState().cfg.mode === "auto" ? "auto" : "ask");
    S.toggleMode();
    app.unmount();
  });
});

describe("hub", () => {
  test("switch model with arrows + enter, persisted to config", async () => {
    S.openHub("models");
    const app = render(<Hub />);
    await tick(80);
    const f = strip(app.lastFrame());
    expect(f).toContain("Walrus Hub");
    expect(f).toContain("llama3.2:3b");
    expect(f).toContain("+ Pull a model");
    app.stdin.write("\x1b[A"); // up (cursor starts at 0 = llama3.2:3b, sorted)
    await tick();
    app.stdin.write("\r");
    await tick();
    expect(S.store.getState().cfg.model).toBe("llama3.2:3b");
    const saved = JSON.parse(readFileSync(join(root, "walrus", "config.json"), "utf8"));
    expect(saved.model).toBe("llama3.2:3b");
    app.unmount();
  });

  test("skills tab: filter and toggle", async () => {
    S.setHubTab("skills");
    const app = render(<Hub />);
    await tick();
    app.stdin.write("brain");
    await tick();
    expect(strip(app.lastFrame())).toContain("brainstorm");
    app.stdin.write(" ");
    await tick();
    expect(S.store.getState().skills.find((s) => s.name === "brainstorm")!.enabled).toBe(false);
    expect(S.store.getState().cfg.skills.brainstorm).toBe(false);
    app.stdin.write(" ");
    await tick();
    expect(S.store.getState().skills.find((s) => s.name === "brainstorm")!.enabled).toBe(true);
    app.unmount();
  });

  test("right arrow moves to agents; esc closes", async () => {
    S.setHubTab("skills");
    const app = render(<Hub />);
    await tick();
    app.stdin.write("\x1b[C");
    await tick();
    expect(S.store.getState().hubTab).toBe("agents");
    app.stdin.write("\x1b");
    await tick(80);
    expect(S.store.getState().view).toBe("chat");
    app.unmount();
  });
});

describe("permissions", () => {
  test("web_fetch asks first, and always covers only that host", async () => {
    const page = (host: string) => `http://${host}:${server.port}/page`;
    chatReplies = [
      { tool: "web_fetch", args: { url: page("localhost") } },
      { tool: "web_fetch", args: { url: page("localhost") } },
      { tool: "web_fetch", args: { url: page("127.0.0.1") } },
      "fetched",
    ];
    const before = S.store.getState().items.length;
    const app = render(<App skipInit />);
    await tick();
    app.stdin.write("fetch it");
    await tick();
    app.stdin.write("\r");
    await waitFor(() => S.store.getState().permission !== null);
    await tick();
    expect(strip(app.lastFrame())).toContain(`GET ${page("localhost")}`);
    expect(strip(app.lastFrame())).toContain(`always allow web_fetch for localhost:${server.port}`);
    S.answerPermission("always");
    await waitFor(() => S.store.getState().permission?.input.url === page("127.0.0.1"));
    S.answerPermission("no");
    await waitFor(() => !S.store.getState().running);
    const fetches = S.store.getState().items.slice(before).filter((i) => i.kind === "tool" && i.tool === "web_fetch");
    expect(fetches.map((i) => i.kind === "tool" && i.ok)).toEqual([true, true, false]);
    app.unmount();
  });

  test("keys typed just before a prompt don't answer it, and the draft survives", async () => {
    chatReplies = [{ tool: "bash", args: { cmd: "echo hi" } }, "done"];
    const app = render(<App skipInit />);
    await tick();
    app.stdin.write("run it");
    await tick();
    app.stdin.write("\r");
    app.stdin.write("and then"); // typing the next message while the model works
    await waitFor(() => S.store.getState().permission !== null);
    app.stdin.write("a"); // still typing as the prompt appears
    await tick();
    expect(S.store.getState().permission).not.toBeNull();
    await tick(PROMPT_GRACE_MS + 100);
    app.stdin.write("y");
    await waitFor(() => !S.store.getState().running);
    await tick();
    expect(strip(app.lastFrame())).toContain("› and then");
    app.unmount();
    S.store.setState({ draft: "" });
  }, 20_000); // runs a real shell: Git Bash starts slowly on a cold Windows runner
});

describe("live", () => {
  test("a long streamed answer stays shorter than the terminal", async () => {
    const app = render(<Live />);
    (app.stdout as unknown as { rows: number }).rows = 24;
    S.store.setState({ running: true, live: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") });
    await tick();
    const frame = strip(app.lastFrame());
    expect(frame).toContain("line 59");
    expect(frame).toContain("more lines");
    expect(frame.split("\n").length).toBeLessThan(24 - 5); // room for the input box and HUD
    app.unmount();
    S.store.setState({ running: false, live: "" });
  });
});

describe("run-only flags", () => {
  test("-m and --yolo are not saved; changing the setting yourself is", async () => {
    const saved = () => JSON.parse(readFileSync(join(root, "walrus", "config.json"), "utf8"));
    const before = saved();
    S.applyFlags({ mode: "auto" });
    await S.init({ model: "qwen3:1.7b" });
    expect(S.store.getState().cfg).toMatchObject({ model: "qwen3:1.7b", mode: "auto" });
    S.toggleThink(); // any change saves the config
    expect(saved()).toMatchObject({ model: before.model, mode: before.mode });
    S.toggleThink();
    S.setModel("qwen3:1.7b");
    expect(saved()).toMatchObject({ model: "qwen3:1.7b", mode: before.mode });
    S.toggleMode();
    expect(saved().mode).toBe("ask");
  });
});

test("config file only lives in the temp home", () => {
  expect(existsSync(join(root, "walrus", "config.json"))).toBe(true);
});

describe("new input features", () => {
  test("@ suggests files and tab completes the path", async () => {
    const app = render(<App skipInit />);
    await tick();
    app.stdin.write("see @Buddy");
    await waitFor(() => strip(app.lastFrame()).includes("@src/ui/Buddy.tsx"));
    app.stdin.write("\t");
    await tick();
    expect(strip(app.lastFrame())).toContain("see @src/ui/Buddy.tsx");
    app.unmount();
  });

  test("ctrl+j makes a multi-line prompt; attachment is sent to the model", async () => {
    chatReplies = ["got it"];
    const app = render(<App skipInit />);
    await tick();
    for (const c of ["line one", "\n", "@package.json"]) {
      app.stdin.write(c);
      await tick();
    }
    app.stdin.write(" ");
    app.stdin.write("\r");
    await waitFor(() => !S.store.getState().running && S.store.getState().items.some((i) => i.kind === "assistant" && i.text === "got it"));
    const user = S.store.getState().items.findLast((i) => i.kind === "user")!;
    expect(user).toMatchObject({ text: "line one\n@package.json" });
    expect((user as { files?: string[] }).files?.[0]).toContain("package.json");
    await tick();
    expect(strip(app.frames.join("\n"))).toContain("⎘");
    app.unmount();
  });

  test("/resume restores an earlier conversation", async () => {
    S.clearConversation();
    expect(S.store.getState().items.filter((i) => i.kind === "user")).toHaveLength(0);
    const app = render(<App skipInit />);
    await tick();
    for (const c of "/resume") app.stdin.write(c);
    app.stdin.write("\r");
    await waitFor(() => S.store.getState().view === "resume");
    await tick();
    expect(strip(app.lastFrame())).toContain("Resume a conversation");
    app.stdin.write("\r");
    await waitFor(() => S.store.getState().view === "chat");
    expect(S.store.getState().items.some((i) => i.kind === "user")).toBe(true);
    app.unmount();
  });
});

describe("mcp in the hub", () => {
  test("toggle a server on, then the model can call its tool", async () => {
    S.openHub("mcp");
    const app = render(<Hub />);
    await tick(80);
    expect(strip(app.lastFrame())).toContain("echo");
    app.stdin.write(" ");
    await waitFor(() => S.store.getState().mcp.find((m) => m.spec.name === "echo")?.status === "on", 20_000);
    await tick();
    expect(strip(app.lastFrame())).toContain("connected · 2 tools");
    expect(S.store.getState().cfg.mcp.echo).toBe(true);
    app.unmount();
    S.closeHub();

    chatReplies = [{ tool: "mcp__echo__echo", args: { text: "walrus" } }, "done"];
    await S.submit("use echo");
    const tool = S.store.getState().items.findLast((i) => i.kind === "tool");
    expect(tool).toMatchObject({ tool: "mcp__echo__echo", result: "echo: walrus", ok: true });
    await S.shutdown();
  }, 30_000);
});

test("tab merged with the next keystrokes still completes the mention", async () => {
  const app = render(<App skipInit />);
  await tick();
  app.stdin.write("see @Buddy");
  await waitFor(() => strip(app.lastFrame()).includes("@src/ui/Buddy.tsx"));
  app.stdin.write("\t? ok");
  await tick();
  expect(strip(app.lastFrame())).toContain("see @src/ui/Buddy.tsx ? ok");
  app.unmount();
});
