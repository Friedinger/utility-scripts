import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { git } from "../src/lib/git.ts";
import { findRepos } from "../src/sync-git-repos/repos.ts";
import {
  type ReviewItem,
  Sync,
  type SyncOptions,
  fetchAll,
  preview,
} from "../src/sync-git-repos/sync.ts";
import { tempDir } from "./helpers.ts";
import {
  REPOS,
  SANDBOX_NAME,
  createSandbox,
  isolatedGitEnv,
} from "./sync-sandbox.ts";

const cli = fileURLToPath(
  new URL("../src/sync-git-repos/cli.ts", import.meta.url),
);

let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  const sandbox = join(await tempDir(), SANDBOX_NAME);
  root = createSandbox(sandbox);
  env = isolatedGitEnv(sandbox);
  // The code under test runs git in this process too.
  for (const [k, v] of Object.entries(env))
    if (k.startsWith("GIT_")) vi.stubEnv(k, v!);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  };
}, 60_000);

const repo = (name: string): string => join(root, name);
const head = (name: string, ref = "HEAD"): string =>
  git(repo(name), "rev-parse", ref).out;
const branches = (name: string): string[] =>
  git(repo(name), "branch", "--format=%(refname:short)").lines.sort();

/** Fetches and syncs every sandbox repo, like step 1 of the CLI. */
async function syncAll(options: SyncOptions = {}): Promise<Sync> {
  const sync = new Sync(root, options);
  const paths = findRepos(root);
  const fetched = await fetchAll(paths);
  for (const p of paths) sync.syncRepo(p, fetched.get(p)!);
  return sync;
}

const itemOf = (sync: Sync, repoName: string, kind: string): ReviewItem => {
  const item = sync.items.find((i) => i.repo === repoName && i.kind === kind);
  if (!item) throw new Error(`no ${kind} entry for ${repoName}`);
  return item;
};

describe("step 1: sync", () => {
  it("updates what is safe and reports the rest", async () => {
    const sync = await syncAll();
    const state = Object.fromEntries(
      sync.results.map((r) => [r.name, r.state]),
    );
    expect(state).toEqual({
      behind: "updated",
      "dirty-clean": "updated",
      "dirty-overlap": "skipped",
      diverged: "skipped",
      "merged-branch": "updated",
      npm: "updated",
      "squash-merged": "updated",
      "unmerged-gone": "updated",
      "wip-branch": "updated",
    });
    expect(head("behind")).toBe(head("behind", "origin/main"));
    // Updated without switching away from the work branch.
    expect(head("wip-branch", "main")).toBe(head("wip-branch", "origin/main"));
    expect(git(repo("wip-branch"), "branch", "--show-current").out).toBe(
      "wip2",
    );
    // Local changes that do not collide are kept.
    expect(readFileSync(join(repo("dirty-clean"), "f.txt"), "utf8")).toContain(
      "Z",
    );
  });

  it("collects the decisions, pre-marking only the safe ones", async () => {
    const sync = await syncAll();
    const summary = sync.items
      .map(
        (i) =>
          `${i.repo} ${i.kind}${i.marked ? " marked" : ""}${i.flagged ? " flagged" : ""}`,
      )
      .sort();
    expect(summary).toEqual([
      "dirty-overlap stash",
      "diverged reset flagged",
      "merged-branch switch marked",
      "npm npm",
      "squash-merged delete marked",
      "unmerged-gone delete flagged",
      "wip-branch switch",
    ]);
  });

  it("describes every decision in the preview", async () => {
    const sync = await syncAll();
    for (const item of sync.items)
      expect(preview(item).length).toBeGreaterThan(0);
    expect(preview(itemOf(sync, "diverged", "reset")).join("\n")).toContain(
      "local commit on main",
    );
  });

  it("reports a failed fetch", async () => {
    const sync = new Sync(root);
    sync.syncRepo(repo("behind"), false);
    expect(sync.results[0]).toMatchObject({ state: "failed", name: "behind" });
  });
});

describe("step 3: running decisions", () => {
  it("resets a diverged main and keeps a backup", async () => {
    const sync = await syncAll();
    const local = head("diverged", "main");
    sync.run(itemOf(sync, "diverged", "reset"));
    expect(head("diverged", "main")).toBe(head("diverged", "origin/main"));
    const backup = branches("diverged").find((b) =>
      b.startsWith("backup/main-"),
    );
    expect(backup && head("diverged", backup)).toBe(local);
    expect(sync.results.find((r) => r.name === "diverged")?.state).toBe(
      "updated",
    );
  });

  it("stashes, updates and restores overlapping changes", async () => {
    const sync = await syncAll();
    sync.run(itemOf(sync, "dirty-overlap", "stash"));
    expect(head("dirty-overlap")).toBe(head("dirty-overlap", "origin/main"));
    const f = readFileSync(join(repo("dirty-overlap"), "f.txt"), "utf8");
    expect(f).toContain("A"); // upstream change
    expect(f).toContain("C"); // local change
  });

  it("switches and deletes a finished branch", async () => {
    const sync = await syncAll();
    sync.run(itemOf(sync, "merged-branch", "switch"));
    expect(git(repo("merged-branch"), "branch", "--show-current").out).toBe(
      "main",
    );
    expect(branches("merged-branch")).toEqual(["main"]);
  });

  it("deletes a squash-merged branch", async () => {
    const sync = await syncAll();
    sync.run(itemOf(sync, "squash-merged", "delete"));
    expect(branches("squash-merged")).toEqual(["main"]);
  });

  it("runs npm install", async () => {
    const sync = await syncAll();
    sync.run(itemOf(sync, "npm", "npm"));
    expect(sync.results.filter((r) => r.state === "failed")).toEqual([]);
    expect(
      readFileSync(join(repo("npm"), "package-lock.json"), "utf8"),
    ).toContain('"version": "1.0.1"');
  }, 60_000);

  it("--cleanup runs only the pre-marked entries", async () => {
    const sync = await syncAll({ cleanup: true, installDeps: false });
    const { run, ask } = sync.split();
    expect(ask).toEqual([]);
    expect(run.map((i) => `${i.repo} ${i.kind}`).sort()).toEqual([
      "merged-branch switch",
      "squash-merged delete",
    ]);
    sync.runAll(run);
    expect(branches("unmerged-gone")).toContain("wip"); // flagged, so kept
    expect(branches("squash-merged")).toEqual(["main"]);
  });
});

describe("findRepos", () => {
  it("skips node_modules, hidden folders and respects the depth", async () => {
    const dir = await tempDir();
    for (const p of [
      "a/.git",
      "b/c/.git",
      "node_modules/x/.git",
      ".hidden/y/.git",
    ])
      mkdirSync(join(dir, p), { recursive: true });
    writeFileSync(join(dir, "file.txt"), "");
    expect(findRepos(dir)).toEqual([join(dir, "a"), join(dir, "b", "c")]);
    expect(findRepos(dir, 1)).toEqual([join(dir, "a")]);
  });
});

describe("sync-git-repos cli", () => {
  it("syncs non-interactively and skips the open decisions", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [cli, root],
      {
        env: { ...env, NO_COLOR: "1" },
      },
    );
    expect(stdout).toContain(`Syncing ${REPOS.length} repos`);
    expect(stdout).toContain(
      "7 open decisions skipped, no interactive terminal.",
    );
    expect(stdout).toContain(
      "Updated: 7, up to date: 0, skipped: 2, failed: 0",
    );
  }, 60_000);

  it("runs the pre-marked cleanup with --cleanup", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [cli, root, "--cleanup", "--no-install-deps"],
      { env: { ...env, NO_COLOR: "1" } },
    );
    expect(stdout).toContain("Switched:   merged-branch  ('feat/a' -> 'main')");
    expect(stdout).toContain("branches deleted: 2");
    expect(stdout).not.toContain("open decisions");
  }, 60_000);

  it("rejects a bad depth", async () => {
    const run = promisify(execFile)(process.execPath, [cli, root, "-d", "0"], {
      env,
    });
    await expect(run).rejects.toMatchObject({
      stdout: expect.stringContaining("--max-depth needs a number"),
    });
  });
});
