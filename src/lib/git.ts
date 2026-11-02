import { execFile, spawnSync } from "node:child_process";

export interface GitResult {
  ok: boolean;
  /** stdout without the trailing newline. */
  out: string;
  /** Non-empty lines of stdout. */
  lines: string[];
}

// Paths with umlauts etc. come out as they are instead of octal-escaped.
const BASE = ["-c", "core.quotepath=false"];

// No credential prompts for the non-interactive calls: a repo that needs a
// login fails (reported as a failed fetch) instead of blocking the run, where
// several parallel fetches would otherwise prompt into the same terminal.
const QUIET_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GCM_INTERACTIVE: "never",
};

function result(ok: boolean, stdout: string): GitResult {
  const out = stdout.trimEnd();
  return { ok, out, lines: out.split(/\r?\n/).filter(Boolean) };
}

/** Runs git in `cwd` and waits for it. Never throws for a failing command. */
export function git(cwd: string, ...args: string[]): GitResult {
  const r = spawnSync("git", [...BASE, ...args], {
    cwd,
    env: QUIET_ENV,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return result(r.status === 0, r.stdout);
}

/** Like {@link git}, without blocking, for running many repos at once. */
export function gitAsync(cwd: string, ...args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...BASE, ...args],
      { cwd, env: QUIET_ENV, encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve(result(!error, stdout));
      },
    );
  });
}

/** Runs git attached to the terminal, so its pager works. */
export function gitInteractive(cwd: string, ...args: string[]): void {
  spawnSync("git", [...BASE, ...args], { cwd, stdio: "inherit" });
}
