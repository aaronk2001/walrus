import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Key } from "ink";

const root = mkdtempSync(join(tmpdir(), "walrus-feat-"));
process.env.WALRUS_HOME = join(root, "walrus");
process.env.CLAUDE_HOME = join(root, "claude");
process.env.OPENCODE_CONFIG_DIR = join(root, "opencode");
process.env.AGENTS_SKILLS_DIR = join(root, "agents-skills");
process.env.CLAUDE_JSON = join(root, "claude.json");

const { saveSession, loadSession, listSessions, appendPromptHistory, loadPromptHistory, timeAgo } = await import("../src/sessions");
const { discoverCommands, expandCommand } = await import("../src/userCommands");
const { matchFiles, mentionAt, expandMentions, listFiles } = await import("../src/attachments");
const { discoverServers, expandEnv } = await import("../src/mcp");
const { resolveTool, repairArgs } = await import("../src/agent/repair");
const { ALL_TOOLS } = await import("../src/agent/tools");
const { applyEdit } = await import("../src/ui/Input");
const { renderPixels, tinyWalrus } = await import("../src/mascot");
const { cosine } = await import("../src/router");

const key = (k: Partial<Key> = {}): Key =>
  ({
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
    return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
    home: false, end: false, super: false, hyper: false, capsLock: false, numLock: false,
    ...k,
  }) as Key;

function write(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("sessions", () => {
  test("save, load, list current folder first", () => {
    const base = { model: "m", created: "2026-09-01T00:00:00Z", history: [{ role: "user" as const, content: "hi" }], items: [] };
    saveSession({ ...base, id: "a", cwd: "C:/other", title: "other", updated: "2026-09-03T00:00:00Z" });
    saveSession({ ...base, id: "b", cwd: "C:/here", title: "here old", updated: "2026-09-01T00:00:00Z" });
    saveSession({ ...base, id: "c", cwd: "C:\\HERE", title: "here new", updated: "2026-09-02T00:00:00Z" });
    expect(listSessions("c:/here").map((s) => s.id)).toEqual(["c", "b", "a"]);
    expect(loadSession("a")!.title).toBe("other");
    expect(listSessions()[0]!.turns).toBe(1);
  });
  test("prompt history persists", () => {
    appendPromptHistory("one");
    appendPromptHistory("multi\nline");
    expect(loadPromptHistory()).toEqual(["one", "multi\nline"]);
  });
  test("timeAgo", () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    expect(timeAgo("2026-09-24T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-09-24T09:00:00Z", now)).toBe("3h ago");
    expect(timeAgo("2026-09-20T12:00:00Z", now)).toBe("4d ago");
  });
});

describe("user commands", () => {
  test("discovers walrus and claude commands, walrus wins", () => {
    write(join(root, "walrus", "commands", "review.md"), "---\ndescription: Review code\nargument-hint: <file>\n---\nReview $ARGUMENTS carefully. First: $1");
    write(join(root, "claude", "commands", "review.md"), "claude version");
    write(join(root, "claude", "commands", "Plain.md"), "Say hello");
    const cmds = discoverCommands();
    expect(cmds.map((c) => [c.name, c.source])).toEqual([["plain", "claude"], ["review", "walrus"]]);
    expect(cmds[1]!.argHint).toBe("<file>");
    expect(expandCommand(cmds[1]!, "a.ts b.ts")).toBe("Review a.ts b.ts carefully. First: a.ts");
    expect(expandCommand(cmds[0]!, "extra")).toBe("Say hello\n\nextra");
  });
});

describe("@file attachments", () => {
  test("mentionAt finds the token under the cursor", () => {
    expect(mentionAt("look at @src/ma", 15)).toEqual({ start: 8, query: "src/ma" });
    expect(mentionAt("email a@b.com", 13)).toBeNull();
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  });
  test("matchFiles ranks basename prefix first", () => {
    const files = ["src/ui/Hub.tsx", "src/hub/index.ts", "docs/github.md", "README.md"];
    expect(matchFiles(files, "hub")).toEqual(["src/ui/Hub.tsx", "docs/github.md", "src/hub/index.ts"]);
  });
  test("expandMentions attaches existing files only", async () => {
    const dir = join(root, "proj");
    write(join(dir, "src", "a.ts"), "export const a = 1;");
    write(join(dir, "node_modules", "x", "i.js"), "skip");
    const { prompt, files } = expandMentions("explain @src/a.ts and @missing.ts.", dir);
    expect(files).toHaveLength(1);
    expect(prompt).toContain('<file path="src/a.ts">\nexport const a = 1;\n</file>');
    expect(await listFiles(dir)).toEqual(["src/a.ts"]);
  });
});

describe("mcp discovery", () => {
  test("reads walrus, claude user/project, and enabled plugin servers", () => {
    process.env.WALRUS_TEST_TOKEN = "tok";
    write(join(root, "walrus", "mcp.json"), JSON.stringify({ mcpServers: { mine: { command: "node", args: ["s.js"] } } }));
    write(
      join(root, "claude.json"),
      JSON.stringify({
        mcpServers: { user1: { type: "stdio", command: "uvx", args: ["srv"] }, old: { type: "sse", url: "http://x" } },
        projects: { "C:\\proj": { mcpServers: { proj1: { command: "p" } } } },
      }),
    );
    write(join(root, "claude", "settings.json"), JSON.stringify({ enabledPlugins: { "docs@market": true, "off@market": false } }));
    write(
      join(root, "claude", "plugins", "cache", "market", "docs", "v1", ".mcp.json"),
      JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://d/mcp", headers: { Authorization: "Bearer ${WALRUS_TEST_TOKEN}" } } } }),
    );
    write(join(root, "claude", "plugins", "cache", "market", "off", "v1", ".mcp.json"), JSON.stringify({ mcpServers: { nope: { command: "x" } } }));
    const servers = discoverServers("c:/proj");
    expect(servers.map((s) => `${s.name}:${s.source}:${s.type}`)).toEqual([
      "docs:plugin:http",
      "mine:walrus:stdio",
      "proj1:claude:stdio",
      "user1:claude:stdio",
    ]);
    expect(servers[0]!.headers).toEqual({ Authorization: "Bearer tok" });
  });
  test("expandEnv defaults", () => {
    expect(expandEnv("${NOPE_NOT_SET:-fallback}/${NOPE_NOT_SET}")).toBe("fallback/");
  });
});

describe("tool repair", () => {
  test("resolves near-miss names, rejects far ones", () => {
    expect(resolveTool("ReadFile", ALL_TOOLS)?.name).toBe("read_file");
    expect(resolveTool("tools.web-search", ALL_TOOLS)?.name).toBe("web_search");
    expect(resolveTool("grepp", ALL_TOOLS)?.name).toBe("grep");
    expect(resolveTool("launch_rocket", ALL_TOOLS)).toBeUndefined();
  });
  test("coerces numbers and JSON arrays", () => {
    const read = ALL_TOOLS.find((t) => t.name === "read_file")!;
    expect(repairArgs(read, { path: "a", limit: "20" })).toEqual({ args: { path: "a", limit: 20 }, problem: null });
    const todo = ALL_TOOLS.find((t) => t.name === "todo_write")!;
    const r = repairArgs(todo, { todos: '[{"content":"x","status":"pending"}]' });
    expect(Array.isArray(r.args.todos)).toBe(true);
    expect(repairArgs(todo, { todos: "nope" }).problem).toContain("`todos` must be an array");
    expect(repairArgs(read, "{bad").problem).toBe("arguments were not valid JSON");
  });
});

describe("multi-line input", () => {
  test("ctrl+j inserts newline, paste keeps lines, home/end are per line", () => {
    let e = { value: "ab", cursor: 2 };
    e = applyEdit(e, "\n", key(), true)!;
    e = applyEdit(e, "cd\r\nef", key(), true)!;
    expect(e).toEqual({ value: "ab\ncd\nef", cursor: 8 });
    expect(applyEdit(e, "", key({ home: true }), true)!.cursor).toBe(6);
    expect(applyEdit({ value: "ab\ncd", cursor: 0 }, "", key({ end: true }), true)!.cursor).toBe(2);
    expect(applyEdit({ value: "", cursor: 0 }, "a\nb", key())!.value).toBe("a b");
  });
});

describe("walrus buddy", () => {
  test("every mood renders 3 rows of 12 cells", () => {
    for (const mood of ["idle", "blink", "look", "sleepy"] as const) {
      const rows = renderPixels(tinyWalrus(mood));
      expect(rows).toHaveLength(3);
      for (const r of rows) expect(r.replace(/\x1b\[[0-9;]*m/g, "")).toHaveLength(12);
    }
  });
  test("cosine", () => {
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});

describe("mcp client (real stdio server)", () => {
  test("connects, maps tools, honors readOnlyHint, calls tools", async () => {
    const { connect } = await import("../src/mcp");
    const conn = await connect({
      name: "echo",
      source: "walrus",
      type: "stdio",
      command: process.execPath,
      args: [join(import.meta.dir, "fixtures", "echo-mcp.ts")],
    });
    try {
      const byName = Object.fromEntries(conn.tools.map((t) => [t.name, t]));
      expect(Object.keys(byName).sort()).toEqual(["mcp__echo__delete_everything", "mcp__echo__echo"]);
      expect(byName.mcp__echo__echo!.mutates).toBe(false);
      expect(byName.mcp__echo__delete_everything!.mutates).toBe(true);
      expect(byName.mcp__echo__echo!.parameters.required).toEqual(["text"]);
      const ctx = { cwd: ".", signal: new AbortController().signal };
      expect(await byName.mcp__echo__echo!.execute({ text: "hi" }, ctx)).toBe("echo: hi");
      expect(await byName.mcp__echo__delete_everything!.execute({ target: "x" }, ctx)).toBe("error: would delete x");
    } finally {
      await conn.client.close();
    }
  }, 30_000);
});

describe("regressions from real-terminal runs", () => {
  test("tools ignore a stray @ from file mentions", async () => {
    const { resolvePath } = await import("../src/agent/tools/fs");
    expect(resolvePath("@src/a.ts", "C:/proj")).toBe(resolvePath("src/a.ts", "C:/proj"));
    expect(resolvePath("@", "C:/proj").endsWith("@")).toBe(true);
  });
});

describe("opencode", () => {
  test("parseJsonc handles comments, trailing commas, and // inside strings", async () => {
    const { parseJsonc } = await import("../src/opencode");
    expect(parseJsonc('{\n // c\n "url": "https://x/y", /* b */ "a": [1,2,],\n}')).toEqual({ url: "https://x/y", a: [1, 2] });
  });

  test("walrus reads opencode agents, commands, skills and MCP (jsonc)", async () => {
    const oc = join(root, "opencode");
    write(join(oc, "agents", "ocagent.md"), "---\ndescription: From OpenCode\nmode: subagent\n---\nOC AGENT");
    write(join(oc, "command", "occmd.md"), "---\ndescription: OC command\n---\nDo $ARGUMENTS");
    write(join(oc, "skills", "ocskill", "SKILL.md"), "---\nname: ocskill\ndescription: OC skill\n---\nX");
    write(join(oc, "opencode.jsonc"), '{\n  // mine\n  "mcp": { "ocmcp": { "type": "local", "command": ["srv", "--token", "{env:TOK}"] },\n   "ocremote": { "type": "remote", "url": "https://r/mcp" }, }\n}');
    const { discoverAgents, discoverSkills } = await import("../src/catalog");
    const { DEFAULTS } = await import("../src/config");
    expect(discoverAgents(DEFAULTS, [], "C:/nowhere").find((a) => a.name === "ocagent")).toMatchObject({ source: "opencode", description: "From OpenCode" });
    expect(discoverSkills(DEFAULTS, "C:/nowhere").find((s) => s.name === "ocskill")).toMatchObject({ source: "opencode", enabled: true });
    expect(discoverCommands("C:/nowhere").find((c) => c.name === "occmd")).toMatchObject({ source: "opencode" });
    const servers = discoverServers("C:/nowhere");
    expect(servers.find((s) => s.name === "ocmcp")).toMatchObject({ source: "opencode", type: "stdio", command: "srv", args: ["--token", ""] });
    expect(servers.find((s) => s.name === "ocremote")).toMatchObject({ type: "http", url: "https://r/mcp" });
  });

  test("sync writes provider, MCP, agents, commands, skills; keeps user files and secrets out", async () => {
    const { syncToOpenCode, PROVIDER_ID } = await import("../src/opencode");
    const oc = join(root, "sync-oc");
    process.env.OPENCODE_CONFIG_DIR = oc;
    try {
      write(join(oc, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", theme: "dark", mcp: { mine: { type: "local", command: ["x"] } } }));
      write(join(oc, "agents", "taken.md"), "USER OWNED");
      const agentFile = (name: string, body: string, tools?: string) =>
        write(join(root, "agentsrc", `${name}.md`), `---\nname: ${name}\ndescription: ${name} desc\n${tools ? `tools: ${tools}\n` : ""}---\n${body}`);
      agentFile("reviewer", "Review code.", "Read, Grep");
      agentFile("taken", "Should not overwrite");
      const agent = (name: string, tools: string[] | null) => ({
        name, description: `${name} desc`, path: join(root, "agentsrc", `${name}.md`), source: "claude" as const, tools, model: null, enabled: true,
      });
      write(join(root, "cmdsrc", "ship.md"), "---\ndescription: Ship it\n---\nShip $ARGUMENTS");
      write(join(root, "walrus", "skills", "wskill", "SKILL.md"), "---\nname: wskill\ndescription: W\n---\nW");
      write(join(root, "walrus", "skills", "wskill", "extra.txt"), "resource");
      const servers = [
        { name: "gh", source: "claude" as const, type: "http" as const, url: "https://gh/mcp?k=SECRET", headers: { Authorization: "Bearer SECRET" },
          raw: { type: "http", url: "https://gh/mcp?k=${GH_KEY}", headers: { Authorization: "Bearer ${GH_TOKEN:-}" } } },
        { name: "local1", source: "walrus" as const, type: "stdio" as const, command: "uvx", args: ["srv"], raw: { command: "uvx", args: ["srv"] } },
        { name: "mine", source: "claude" as const, type: "stdio" as const, command: "y", args: [], raw: { command: "y" } },
      ];
      const input = {
        ollamaHost: "http://localhost:11434",
        models: ["qwen3:1.7b"],
        servers,
        mcpEnabled: { gh: true },
        agents: [agent("reviewer", ["read_file", "grep"]), agent("taken", null)],
        commands: [{ name: "ship", description: "Ship it", argHint: "", path: join(root, "cmdsrc", "ship.md"), source: "claude" as const }],
        skills: [
          { name: "wskill", description: "W", path: join(root, "walrus", "skills", "wskill", "SKILL.md"), source: "walrus" as const, enabled: true },
          { name: "cskill", description: "C", path: "x", source: "claude" as const, enabled: true },
        ],
      };
      const r = syncToOpenCode(input);
      const conf = JSON.parse(readFileSync(join(oc, "opencode.json"), "utf8"));
      expect(conf.theme).toBe("dark");
      expect(conf.provider[PROVIDER_ID].options.baseURL).toBe("http://localhost:11434/v1");
      expect(Object.keys(conf.provider[PROVIDER_ID].models)).toEqual(["qwen3:1.7b-16k"]);
      expect(conf.mcp.gh).toEqual({ type: "remote", url: "https://gh/mcp?k={env:GH_KEY}", headers: { Authorization: "Bearer {env:GH_TOKEN}" }, enabled: true });
      expect(conf.mcp.local1).toEqual({ type: "local", command: ["uvx", "srv"], enabled: false });
      expect(conf.mcp.mine).toEqual({ type: "local", command: ["x"] });
      expect(JSON.stringify(conf)).not.toContain("SECRET");
      expect(readFileSync(join(oc, "agents", "reviewer.md"), "utf8")).toBe(
        '---\ndescription: "reviewer desc"\nmode: subagent\npermission:\n  edit: deny\n  bash: deny\n  webfetch: deny\n---\n\nReview code.\n',
      );
      expect(readFileSync(join(oc, "agents", "taken.md"), "utf8")).toBe("USER OWNED");
      expect(readFileSync(join(oc, "commands", "ship.md"), "utf8")).toContain("Ship $ARGUMENTS");
      expect(readFileSync(join(oc, "skills", "wskill", "extra.txt"), "utf8")).toBe("resource");
      expect(existsSync(join(oc, "skills", "cskill"))).toBe(false);
      expect(r.skipped.sort()).toEqual(["mcp:mine", "taken"]);

      // second sync without reviewer/gh removes only what walrus created
      syncToOpenCode({ ...input, agents: [], servers: servers.slice(1) });
      const conf2 = JSON.parse(readFileSync(join(oc, "opencode.json"), "utf8"));
      expect(conf2.mcp.gh).toBeUndefined();
      expect(conf2.mcp.mine).toEqual({ type: "local", command: ["x"] });
      expect(existsSync(join(oc, "agents", "reviewer.md"))).toBe(false);
      expect(readFileSync(join(oc, "agents", "taken.md"), "utf8")).toBe("USER OWNED");
    } finally {
      process.env.OPENCODE_CONFIG_DIR = join(root, "opencode");
    }
  });
});
