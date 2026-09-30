import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Print mode end to end: the real entry point in a child process, against a fake Ollama.
const root = mkdtempSync(join(tmpdir(), "walrus-cli-"));
const chats: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/tags")
      return Response.json({ models: [{ name: "qwen3:1.7b", size: 1.4e9 }, { name: "llama3.2:3b", size: 2e9 }] });
    if (url.pathname === "/api/ps") return Response.json({ models: [] });
    if (url.pathname === "/api/show") return Response.json({ capabilities: ["completion", "tools"] });
    if (url.pathname === "/api/generate") return Response.json({ done: true });
    if (url.pathname === "/api/chat") {
      const { model } = (await req.json()) as { model: string };
      chats.push(model);
      return new Response(
        JSON.stringify({ message: { role: "assistant", content: `hi from ${model}` }, done: false }) +
          "\n" +
          JSON.stringify({ message: { role: "assistant", content: "" }, done: true }) +
          "\n",
      );
    }
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => server.stop(true));

const configPath = join(root, "walrus", "config.json");
const saved = { model: "qwen3:1.7b", ollamaHost: `http://localhost:${server.port}`, mode: "ask" };

async function walrus(...args: string[]) {
  mkdirSync(join(root, "walrus"), { recursive: true });
  writeFileSync(configPath, JSON.stringify(saved));
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "main.tsx"), ...args], {
    env: {
      ...process.env,
      WALRUS_HOME: join(root, "walrus"),
      CLAUDE_HOME: join(root, "claude"),
      CLAUDE_JSON: join(root, "claude.json"),
      AGENTS_SKILLS_DIR: join(root, "agents-skills"),
      OPENCODE_CONFIG_DIR: join(root, "opencode"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out, err, code, config: JSON.parse(readFileSync(configPath, "utf8")) };
}

describe("print mode", () => {
  test("-m and --yolo apply to this run only", async () => {
    const r = await walrus("-p", "hi", "--yolo", "-m", "llama3.2:3b");
    expect(r.code).toBe(0);
    expect(r.out).toContain("hi from llama3.2:3b");
    expect(r.config).toEqual(saved);
  }, 30_000);

  test("an unknown -m model fails instead of answering with another model", async () => {
    chats.length = 0;
    const r = await walrus("-p", "hi", "-m", "nope");
    expect(r.code).toBe(1);
    expect(r.err).toContain('No installed model "nope"');
    expect(chats).toEqual([]);
    expect(r.config).toEqual(saved);
  }, 30_000);
});
