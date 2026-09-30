import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../src/frontmatter";
import { mapAgentTools } from "../src/catalog";
import { renderPixels, WALRUS } from "../src/mascot";
import { thinkSplitter, parseInlineToolCalls, parseBareToolCall, clipOutput, MAX_TOOL_OUTPUT } from "../src/agent/loop";
import { parseCommand, suggest } from "../src/commands";
import { readFile, writeFile, editFile, listDir, grep } from "../src/agent/tools/fs";
import { bash, gitBash } from "../src/agent/tools/shell";
import { htmlToText } from "../src/agent/tools/web";
import { todoWrite, todoStore } from "../src/agent/tools/todo";
import { applyEdit } from "../src/ui/Input";
import { bar } from "../src/ui/Hud";
import { tailToFit } from "../src/ui/Live";
import type { Key } from "ink";

const key = (k: Partial<Key> = {}): Key =>
  ({
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
    return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
    home: false, end: false, super: false, hyper: false, capsLock: false, numLock: false,
    ...k,
  }) as Key;

describe("frontmatter", () => {
  test("scalars, quotes, folded blocks, CRLF", () => {
    const src = '---\r\nname: debugger\r\ndescription: "Find bugs: fast"\r\ntools: Read, Bash\r\n---\r\nBody here\r\n';
    const { data, body } = parseFrontmatter(src);
    expect(data).toEqual({ name: "debugger", description: "Find bugs: fast", tools: "Read, Bash" });
    expect(body.trim()).toBe("Body here");
  });
  test("block scalar", () => {
    const { data } = parseFrontmatter("---\nname: x\ndescription: >\n  line one\n  line two\nmodel: y\n---\n");
    expect(data.description).toBe("line one line two");
    expect(data.model).toBe("y");
  });
  test("no frontmatter", () => {
    expect(parseFrontmatter("# hi").data).toEqual({});
  });
  test("lists read like `tools: Read, Grep`, so agents keep their tool limits", () => {
    const { data } = parseFrontmatter('---\nname: r\ntools:\n  - Read\n  - "Grep"\nmodel: x\n---\n');
    expect(data).toEqual({ name: "r", tools: "Read, Grep", model: "x" });
    expect(mapAgentTools(data.tools)).toEqual(["read_file", "grep"]);
    expect(parseFrontmatter("---\ntools: [Read, 'Grep']\n---\n").data.tools).toBe("Read, Grep");
  });
});

describe("mascot", () => {
  test("renders 12 pixel rows as 6 half-block text rows of width 14", () => {
    const lines = renderPixels(WALRUS);
    expect(lines).toHaveLength(6);
    for (const l of lines) expect(l.replace(/\x1b\[[0-9;]*m/g, "")).toHaveLength(14);
    expect(lines.join("")).toContain("38;2;59;130;246"); // electric blue body
  });
});

describe("thinkSplitter", () => {
  test("splits tags across chunk boundaries", () => {
    const s = thinkSplitter();
    const parts = ["Hi <thi", "nk>secret", " stuff</th", "ink> there"].map(s);
    expect(parts.map((p) => p.content).join("")).toBe("Hi  there");
    expect(parts.map((p) => p.thinking).join("")).toBe("secret stuff");
  });
  test("stray close tag reclassifies earlier content", () => {
    const s = thinkSplitter();
    const a = s("let me count");
    const b = s(" files</think>\n\n6");
    expect(a.content).toBe("let me count");
    expect(b.reset).toBe(true);
    expect(b.thinking).toBe(" files");
    expect(b.content).toBe("\n\n6");
  });
  test("plain text passes through", () => {
    expect(thinkSplitter()("a < b")).toEqual({ content: "a < b", thinking: "", reset: false });
  });
});

describe("loop helpers", () => {
  test("inline tool calls", () => {
    const calls = parseInlineToolCalls('ok <tool_call>{"name":"bash","arguments":{"cmd":"ls"}}</tool_call>');
    expect(calls).toEqual([{ function: { name: "bash", arguments: { cmd: "ls" } } }]);
    expect(parseInlineToolCalls("<tool_call>nope</tool_call>")).toEqual([]);
  });
  test("bare JSON tool calls", () => {
    const call = { function: { name: "read_file", arguments: { path: "a.ts" } } };
    expect(parseBareToolCall('{"name": "read_file", "arguments": {"path": "a.ts"}}')).toEqual(call);
    expect(parseBareToolCall('```json\n{"name": "read_file", "parameters": {"path": "a.ts"}}\n```')).toEqual(call);
    expect(parseBareToolCall('<tool_response>\n{"name": "read_file", "arguments": {"path": "a.ts"}}\n</tool_response>')).toEqual(call);
    expect(parseBareToolCall('{"name": "Ada", "age": 3}')).toBeNull();
    expect(parseBareToolCall('Here: {"name": "x", "arguments": {}}')).toBeNull();
  });
  test("clipOutput", () => {
    expect(clipOutput("x".repeat(MAX_TOOL_OUTPUT + 10))).toContain("10 chars truncated");
  });
});

describe("commands", () => {
  test("parse", () => {
    expect(parseCommand("/model qwen3:1.7b")).toEqual({ name: "model", args: "qwen3:1.7b" });
    expect(parseCommand("hello")).toBeNull();
  });
  test("suggest commands and skills", () => {
    const s = suggest("/mo", [{ name: "motion", description: "d" }]);
    expect(s.map((x) => x.name)).toEqual(["model", "models", "mode", "motion"]);
    expect(suggest("/model x", [])).toEqual([]);
  });
});

describe("line editing", () => {
  test("insert, move, backspace, ctrl+w", () => {
    let e = { value: "", cursor: 0 };
    e = applyEdit(e, "hello world", key())!;
    e = applyEdit(e, "", key({ leftArrow: true }))!;
    e = applyEdit(e, "", key({ backspace: true }))!;
    expect(e).toEqual({ value: "hello word", cursor: 9 });
    e = applyEdit({ value: "a b c", cursor: 5 }, "w", key({ ctrl: true }))!;
    expect(e).toEqual({ value: "a b ", cursor: 4 });
    expect(applyEdit(e, "", key({ return: true }))).toBeNull();
  });
  test("pasted newlines become spaces", () => {
    expect(applyEdit({ value: "", cursor: 0 }, "a\r\nb", key())!.value).toBe("a b");
  });
});

describe("live preview", () => {
  test("keeps the tail that fits and reopens a code block cut off at the top", () => {
    const text = ["intro", "```", ...Array.from({ length: 10 }, (_, i) => `line ${i}`)].join("\n");
    expect(tailToFit(text, 20, 80)).toEqual({ text, hidden: 0 });
    expect(tailToFit(text, 3, 80)).toEqual({ text: "```\nline 7\nline 8\nline 9", hidden: 9 });
  });
  test("long lines count as the rows they wrap to", () => {
    expect(tailToFit(`a\n${"x".repeat(250)}`, 3, 100)).toEqual({ text: "x".repeat(250), hidden: 1 });
    expect(tailToFit("x".repeat(1000), 3, 100)).toEqual({ text: "…" + "x".repeat(299), hidden: 0 });
  });
});

describe("hud", () => {
  test("bar", () => {
    expect(bar(50, 10)).toBe("█████░░░░░");
    expect(bar(150, 4)).toBe("████");
  });
});

describe("tools", () => {
  let dir: string;
  const ctx = () => ({ cwd: dir, signal: new AbortController().signal });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "walrus-tools-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "const x = 1;\nconst y = 2;\n");
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "node_modules", "skip.ts"), "const x = 1;");
  });

  test("write, read with line numbers", async () => {
    expect(await writeFile.execute({ path: "notes/n.txt", content: "one\ntwo" }, ctx())).toContain("wrote 2 lines");
    const out = await readFile.execute({ path: "notes/n.txt" }, ctx());
    expect(out).toBe("    1  one\n    2  two");
  });

  test("read paging", async () => {
    const out = await readFile.execute({ path: "src/a.ts", offset: 1, limit: 1 }, ctx());
    expect(out).toContain("1  const x = 1;");
    expect(out).toContain("more lines");
  });

  test("edit requires unique match", async () => {
    writeFileSync(join(dir, "e.txt"), "foo bar foo");
    expect(await editFile.execute({ path: "e.txt", old: "foo", new: "baz" }, ctx())).toContain("matches 2 times");
    expect(await editFile.execute({ path: "e.txt", old: "nope", new: "x" }, ctx())).toContain("not found");
    expect(await editFile.execute({ path: "e.txt", old: "bar", new: "$&$1" }, ctx())).toContain("edited");
    expect(readFileSync(join(dir, "e.txt"), "utf8")).toBe("foo $&$1 foo");
  });

  test("edit tolerates blank-line and indentation slips in `old`", async () => {
    writeFileSync(join(dir, "w.md"), "# title\nintro line\r\n\n  indented\nend\n");
    const out = await editFile.execute({ path: "w.md", old: "# title\n\nintro line\nindented", new: "# title\nnew" }, ctx());
    expect(out).toContain("edited");
    expect(readFileSync(join(dir, "w.md"), "utf8")).toBe("# title\nnew\nend\n");
    writeFileSync(join(dir, "w2.md"), "a\nb\n\na\nb\n");
    expect(await editFile.execute({ path: "w2.md", old: "a\n\nb", new: "x" }, ctx())).toContain("matches 2 times");
    expect(await editFile.execute({ path: "w2.md", old: "a\nc", new: "x" }, ctx())).toContain("not found");
  });

  test("a miss on a small file shows the file and how to insert", async () => {
    writeFileSync(join(dir, "s.md"), "# title\nbody\n");
    const out = await editFile.execute({ path: "s.md", old: "Endpoints section", new: "## Endpoints" }, ctx());
    expect(out).toContain("To add text, set `old` to the line it goes after");
    expect(out).toContain("The file is:\n# title\nbody");
  });

  test("edit accepts a first or last line cut short", async () => {
    writeFileSync(join(dir, "w3.md"), "# todo-api\nA tiny API. Run it.\nmore\n");
    const out = await editFile.execute({ path: "w3.md", old: "# todo-api\n\nA tiny API", new: "# todo\nA small API" }, ctx());
    expect(out).toContain("edited");
    expect(readFileSync(join(dir, "w3.md"), "utf8")).toBe("# todo\nA small API. Run it.\nmore\n");
    writeFileSync(join(dir, "w4.md"), "x = 1; y = 2\nz = 3\n");
    await editFile.execute({ path: "w4.md", old: "y = 2\nz = 3", new: "y = 5\nz = 6" }, ctx());
    expect(readFileSync(join(dir, "w4.md"), "utf8")).toBe("x = 1; y = 5\nz = 6\n");
    // a single line still has to match exactly
    expect(await editFile.execute({ path: "w4.md", old: "  z = 6 ", new: "q" }, ctx())).toContain("edited");
    expect(await editFile.execute({ path: "w4.md", old: "z = 7", new: "q" }, ctx())).toContain("not found");
  });

  test("list_dir and glob skip node_modules", async () => {
    expect(await listDir.execute({}, ctx())).toContain("src/");
    const g = await listDir.execute({ pattern: "**/*.ts" }, ctx());
    expect(g).toBe("src/a.ts");
  });

  test("grep", async () => {
    const out = await grep.execute({ pattern: "const y" }, ctx());
    expect(out).toBe("src/a.ts:2: const y = 2;");
    expect(await grep.execute({ pattern: "(" }, ctx())).toContain("bad regex");
  });

  test("bash runs in cwd", async () => {
    const out = await bash.execute({ cmd: "echo hi && exit 3" }, ctx());
    expect(out).toContain("hi");
    expect(out).toContain("exit 3");
  });

  test("on Windows, WSL's bash.exe doesn't count as bash", () => {
    const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
    const git = "C:\\Program Files\\Git\\bin\\bash.exe";
    const userGit = "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    expect(gitBash(() => "C:\\Windows\\System32\\bash.exe", (p) => p === git, env)).toBe(git);
    expect(gitBash(() => null, (p) => p === userGit, env)).toBe(userGit);
    expect(gitBash(() => "C:\\Program Files\\Git\\usr\\bin\\bash.exe", () => false, env)).toBe(
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    );
    expect(gitBash(() => `${env.LOCALAPPDATA}\\Microsoft\\WindowsApps\\bash.exe`, () => false, env)).toBeNull();
  });

  test("todo_write", async () => {
    await todoWrite.execute({ todos: [{ content: "a", status: "completed" }, { content: "b", status: "weird" }] }, ctx());
    expect(todoStore.getState().todos).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "pending" },
    ]);
  });

  test("htmlToText", () => {
    expect(htmlToText("<p>a &amp; b</p><script>x</script><div>c</div>")).toBe("a & b\nc");
  });
});
