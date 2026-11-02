import { execFile, spawnSync } from "node:child_process";

export interface GitResult {
  ok: boolean;
  /** stdout without the trailing newline. */
  out: string;
  /** Non-empty lines of stdout. */
  lines: string[];
  /** stderr, trimmed (empty when it went to the terminal). */
  err: string;
}

export interface GitOptions {
  /** Extra environment variables; `undefined` removes one. */
  env?: Record<string, string | undefined>;
  /** Written to git's stdin. */
  input?: string;
  /** Keep stdout exactly as it is (`out` is not trimmed). */
  raw?: boolean;
  /** Let stderr through to the terminal, e.g. for a signing prompt or error. */
  showErrors?: boolean;
}

// Paths with umlauts etc. come out as they are instead of octal-escaped.
const BASE = ["-c", "core.quotepath=false"];

// No credential prompts for the non-interactive calls: a repo that needs a
// login fails (reported as a failed fetch) instead of blocking the run, where
// several parallel fetches would otherwise prompt into the same terminal.
// Built per call, so changes to process.env (as in the tests) still apply.
const quietEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GCM_INTERACTIVE: "never",
});

function result(
  ok: boolean,
  stdout: string,
  stderr = "",
  raw = false,
): GitResult {
  const trimmed = stdout.trimEnd();
  return {
    ok,
    out: raw ? stdout : trimmed,
    lines: trimmed.split(/\r?\n/).filter(Boolean),
    err: (stderr ?? "").trim(),
  };
}

/** Runs git in `cwd` and waits for it. Never throws for a failing command. */
export function git(cwd: string, ...args: string[]): GitResult {
  return gitWith(cwd, {}, ...args);
}

/** Like {@link git}, with extra environment, stdin or raw output. */
export function gitWith(
  cwd: string,
  options: GitOptions,
  ...args: string[]
): GitResult {
  const env = quietEnv();
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const r = spawnSync("git", [...BASE, ...args], {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", options.showErrors ? "inherit" : "pipe"],
    ...(options.input !== undefined && { input: options.input }),
  });
  if (r.error) throw r.error;
  return result(r.status === 0, r.stdout, r.stderr ?? "", options.raw);
}

/** Like {@link git}, without blocking, for running many repos at once. */
export function gitAsync(cwd: string, ...args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...BASE, ...args],
      { cwd, env: quietEnv(), encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve(result(!error, stdout, stderr));
      },
    );
  });
}

/**
 * Runs git attached to the terminal, so its pager and login prompts work.
 * Returns whether it succeeded.
 */
export function gitInteractive(cwd: string, ...args: string[]): boolean {
  const r = spawnSync("git", [...BASE, ...args], { cwd, stdio: "inherit" });
  if (r.error) throw r.error;
  return r.status === 0;
}

/** The repo's actual default branch, via origin/HEAD; falls back to main or master. */
export function detectDefaultBranch(path: string): string | undefined {
  let ref = git(path, "symbolic-ref", "refs/remotes/origin/HEAD");
  if (!ref.ok) {
    git(path, "remote", "set-head", "origin", "-a");
    ref = git(path, "symbolic-ref", "refs/remotes/origin/HEAD");
  }
  if (ref.ok && ref.out) return ref.out.replace(/^refs\/remotes\/origin\//, "");
  return ["main", "master"].find(
    (b) => git(path, "show-ref", "--verify", "--quiet", `refs/heads/${b}`).ok,
  );
}
