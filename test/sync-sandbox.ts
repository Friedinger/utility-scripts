/**
 * Builds throwaway Git repos in every situation sync-git-repos handles, for
 * the tests and for trying it out by hand:
 *
 *   node test/sync-sandbox.ts [folder]    build (or rebuild) the sandbox
 *   node test/sync-sandbox.ts --remove    delete it again
 *
 * The folder must end in "sync-git-repos-sandbox", since it is deleted and
 * recreated; default is the temp folder. Local "remotes" (bare repos) and
 * "seeds" (to push upstream changes) sit next to root/, which holds the clones
 * to sync:
 *
 *   behind          origin has a new commit, the clone is clean
 *   merged-branch   on a feature branch that was merged on origin
 *   squash-merged   a local branch that was squash-merged on origin, upstream deleted
 *   unmerged-gone   a local branch with unmerged work, upstream deleted
 *   diverged        local main and origin/main both have new commits
 *   dirty-overlap   local changes in a file that the update also changes
 *   dirty-clean     local changes in a file that the update does not touch
 *   wip-branch      on a branch with unmerged work, main is behind
 *   npm             behind, has package.json and node_modules
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SANDBOX_NAME = "sync-git-repos-sandbox";

export const REPOS = [
  "behind",
  "merged-branch",
  "squash-merged",
  "unmerged-gone",
  "diverged",
  "dirty-overlap",
  "dirty-clean",
  "wip-branch",
  "npm",
] as const;

/**
 * Environment that keeps the user's own Git config out (signing, hooks,
 * aliases) and gives commits a fixed identity.
 */
export function isolatedGitEnv(path: string): NodeJS.ProcessEnv {
  const config = join(path, "gitconfig");
  writeFileSync(config, "");
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

/** Builds the sandbox in `path` and returns the folder to sync. */
export function createSandbox(path: string): string {
  if (basename(path) !== SANDBOX_NAME)
    throw new Error(`The path must end in '${SANDBOX_NAME}', got: ${path}`);
  rmSync(path, { recursive: true, force: true, maxRetries: 5 });
  mkdirSync(path, { recursive: true });
  const env = isolatedGitEnv(path);

  const g = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, { cwd, env, stdio: "pipe" });
  };
  const write = (file: string, content: string): void =>
    writeFileSync(file, content + "\n");
  const seed = (name: string): string => join(path, "seeds", name);
  const repo = (name: string): string => join(path, "root", name);
  // Upstream side: always start from the latest origin/main.
  const inSeed = (name: string, fn: (dir: string) => void): void => {
    g(seed(name), "pull", "-q", "--ff-only", "origin", "main");
    fn(seed(name));
  };

  for (const name of REPOS) {
    const remote = join(path, "remotes", `${name}.git`);
    g(path, "init", "-q", "--bare", "-b", "main", remote);
    g(path, "clone", "-q", remote, seed(name));
    write(join(seed(name), "f.txt"), "a\nb\nc");
    write(join(seed(name), "g.txt"), "g");
    g(seed(name), "add", "-A");
    g(seed(name), "commit", "-q", "-m", "init");
    g(seed(name), "push", "-q", "origin", "HEAD:main");
    g(path, "clone", "-q", remote, repo(name));
  }

  inSeed("behind", (s) => {
    write(join(s, "g.txt"), "g1");
    g(s, "commit", "-q", "-am", "upstream change");
    g(s, "push", "-q", "origin", "HEAD:main");
  });

  {
    const r = repo("merged-branch");
    g(r, "checkout", "-q", "-b", "feat/a");
    write(join(r, "a.txt"), "a");
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "a");
    g(r, "push", "-q", "-u", "origin", "feat/a");
    inSeed("merged-branch", (s) => {
      g(s, "fetch", "-q");
      g(s, "merge", "-q", "--no-ff", "-m", "merge", "origin/feat/a");
      g(s, "push", "-q", "origin", "HEAD:main");
    });
  }

  {
    const r = repo("squash-merged");
    g(r, "checkout", "-q", "-b", "feat/squash");
    write(join(r, "s1.txt"), "1");
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "s1");
    write(join(r, "s2.txt"), "2");
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "s2");
    g(r, "push", "-q", "-u", "origin", "feat/squash");
    g(r, "checkout", "-q", "main");
    inSeed("squash-merged", (s) => {
      g(s, "fetch", "-q");
      g(s, "merge", "-q", "--squash", "origin/feat/squash");
      g(s, "commit", "-q", "-m", "squash merge");
      g(s, "push", "-q", "origin", "HEAD:main");
      g(s, "push", "-q", "origin", "--delete", "feat/squash");
    });
  }

  {
    const r = repo("unmerged-gone");
    g(r, "checkout", "-q", "-b", "wip");
    write(join(r, "w.txt"), "w");
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "w");
    g(r, "push", "-q", "-u", "origin", "wip");
    g(r, "checkout", "-q", "main");
    inSeed("unmerged-gone", (s) => {
      g(s, "push", "-q", "origin", "--delete", "wip");
      write(join(s, "g.txt"), "g2");
      g(s, "commit", "-q", "-am", "upstream change");
      g(s, "push", "-q", "origin", "HEAD:main");
    });
  }

  {
    const r = repo("diverged");
    write(join(r, "local.txt"), "l");
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "local commit on main");
    inSeed("diverged", (s) => {
      write(join(s, "remote.txt"), "r");
      g(s, "add", "-A");
      g(s, "commit", "-q", "-m", "upstream commit");
      g(s, "push", "-q", "origin", "HEAD:main");
    });
  }

  inSeed("dirty-overlap", (s) => {
    write(join(s, "f.txt"), "A\nb\nc");
    g(s, "commit", "-q", "-am", "upstream change");
    g(s, "push", "-q", "origin", "HEAD:main");
  });
  write(join(repo("dirty-overlap"), "f.txt"), "a\nb\nC");

  inSeed("dirty-clean", (s) => {
    write(join(s, "g.txt"), "g3");
    g(s, "commit", "-q", "-am", "upstream change");
    g(s, "push", "-q", "origin", "HEAD:main");
  });
  write(join(repo("dirty-clean"), "f.txt"), "a\nb\nZ");

  {
    const r = repo("wip-branch");
    g(r, "checkout", "-q", "-b", "wip2");
    write(join(r, "w2.txt"), "w");
    g(r, "add", "-A");
    g(r, "commit", "-q", "-m", "work in progress");
    inSeed("wip-branch", (s) => {
      write(join(s, "g.txt"), "g4");
      g(s, "commit", "-q", "-am", "upstream change");
      g(s, "push", "-q", "origin", "HEAD:main");
    });
  }

  {
    const r = repo("npm");
    inSeed("npm", (s) => {
      write(join(s, "package.json"), '{"name":"x","version":"1.0.0"}');
      g(s, "add", "-A");
      g(s, "commit", "-q", "-m", "add package.json");
      g(s, "push", "-q", "origin", "HEAD:main");
    });
    g(r, "pull", "-q", "--ff-only");
    mkdirSync(join(r, "node_modules"));
    appendFileSync(
      join(r, ".git", "info", "exclude"),
      "node_modules\npackage-lock.json\n",
    );
    inSeed("npm", (s) => {
      write(join(s, "package.json"), '{"name":"x","version":"1.0.1"}');
      g(s, "commit", "-q", "-am", "bump version");
      g(s, "push", "-q", "origin", "HEAD:main");
    });
  }

  return join(path, "root");
}

// Run directly: build or remove the sandbox.
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const remove = args.includes("--remove");
  const path = resolve(
    args.find((a) => a !== "--remove") ?? join(tmpdir(), SANDBOX_NAME),
  );
  if (remove) {
    if (basename(path) !== SANDBOX_NAME)
      throw new Error(`The path must end in '${SANDBOX_NAME}', got: ${path}`);
    rmSync(path, { recursive: true, force: true, maxRetries: 5 });
    console.debug(`Removed ${path}`);
  } else {
    const root = createSandbox(path);
    console.debug(`Sandbox ready: ${root}`);
    console.debug(`Try it with:  sync-git-repos "${root}"`);
    console.debug(`Remove it with:  node test/sync-sandbox.ts --remove`);
  }
}
