import { existsSync } from "node:fs";
import { win32 } from "node:path";
import type { Tool } from "../types";

const TIMEOUT_MS = 120_000;

// On Windows the `bash` on PATH is often WSL's launcher (in System32 or WindowsApps), which runs
// the command inside Linux instead of in this folder. Only Git Bash counts.
export function gitBash(
  which: (cmd: string) => string | null = (cmd) => Bun.which(cmd),
  exists: (path: string) => boolean = existsSync,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const onPath = which("bash");
  if (onPath && !/[\\/](System32|WindowsApps)[\\/]/i.test(onPath)) return onPath;
  for (const root of [env.ProgramFiles, env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs")]) {
    const exe = root && win32.join(root, "Git", "bin", "bash.exe");
    if (exe && exists(exe)) return exe;
  }
  return null;
}

const winBash = process.platform === "win32" ? gitBash() : null;
const SHELL = process.platform !== "win32" ? "sh" : winBash ? "Git Bash" : "cmd.exe";

export function shellArgv(cmd: string): string[] {
  if (process.platform !== "win32") return ["sh", "-c", cmd];
  return winBash ? [winBash, "-c", cmd] : ["cmd", "/d", "/s", "/c", cmd];
}

export const bash: Tool = {
  name: "bash",
  description: `Run a shell command in the working directory with ${SHELL}. Returns output and exit code. 2 min timeout.`,
  mutates: true,
  parameters: {
    type: "object",
    properties: { cmd: { type: "string", description: "Command to run" } },
    required: ["cmd"],
  },
  async execute({ cmd }, ctx) {
    const proc = Bun.spawn(shellArgv(String(cmd)), {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const kill = () => proc.kill();
    ctx.signal.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", kill);
    return [stdout.trimEnd(), stderr.trimEnd() && `stderr:\n${stderr.trimEnd()}`, `exit ${code}`]
      .filter(Boolean)
      .join("\n");
  },
};
