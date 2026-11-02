import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  detectDefaultBranch,
  git,
  gitAsync,
  gitInteractive,
} from "../lib/git.ts";
import { type Color, say } from "../lib/term.ts";

export type ResultState = "updated" | "current" | "skipped" | "failed";

export interface RepoResult {
  state: ResultState;
  name: string;
  detail: string;
}

export type ItemKind = "stash" | "reset" | "switch" | "delete" | "npm";

/** One decision for the review list. */
export interface ReviewItem {
  kind: ItemKind;
  /** Repo path relative to the root. */
  repo: string;
  repoPath: string;
  label: string;
  /** Pre-marked: the sensible choice. */
  marked: boolean;
  /** Needs care: shown in red, never pre-marked. */
  flagged: boolean;
  defaultBranch: string;
  /** The branch the entry is about (delete, switch). */
  branch?: string;
  /** Delete: everything of the branch is already in the default branch. */
  inDefault?: boolean;
  /** Switch: delete the branch after switching. */
  deleteBranch?: boolean;
  /** Reset: the default branch is checked out. */
  onDefault?: boolean;
  /** Stash: local files that the update also changes. */
  overlap?: string[];
  /** Npm: the default branch before and after the update. */
  before?: string;
  after?: string;
  /** Result line to replace when the entry fixes it (stash, reset). */
  record?: RepoResult;
}

export interface SyncOptions {
  /** undefined: ask in the list; true: run the pre-marked entries; false: none. */
  cleanup?: boolean | undefined;
  /** undefined: ask in the list; true: always install; false: never. */
  installDeps?: boolean | undefined;
}

const RESULT_COLORS: Record<ResultState, Color> = {
  updated: "green",
  current: "gray",
  skipped: "yellow",
  failed: "red",
};
const RESULT_LABELS: Record<ResultState, string> = {
  updated: "Updated",
  current: "Up to date",
  skipped: "Skipped",
  failed: "Failed",
};

/** "1 commit" / "2 commits". */
function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One output line: "Label:     name  (detail)", the whole line in one color. */
export function line(
  label: string,
  name: string,
  detail: string,
  color: Color,
): void {
  say(
    `${(label + ":").padEnd(11)} ${name}${detail ? `  (${detail})` : ""}`,
    color,
  );
}

/** Collects the results of a run and prints them as they come. */
export class Sync {
  readonly results: RepoResult[] = [];
  readonly items: ReviewItem[] = [];
  readonly counts = { cleaned: 0, reset: 0, switched: 0 };
  offline = 0;
  readonly options: SyncOptions;
  private readonly root: string;
  private readonly reviewHint: string;

  constructor(root: string, options: SyncOptions = {}) {
    this.root = root;
    this.options = options;
    this.reviewHint = options.cleanup === false ? "" : ", see review";
  }

  name(repoPath: string): string {
    return relative(this.root, repoPath) || ".";
  }

  add(state: ResultState, name: string, detail: string): RepoResult {
    const r = { state, name, detail };
    this.results.push(r);
    line(RESULT_LABELS[state], name, detail, RESULT_COLORS[state]);
    return r;
  }

  private replace(record: RepoResult | undefined): void {
    const at = record ? this.results.indexOf(record) : -1;
    if (at >= 0) this.results.splice(at, 1);
  }

  private item(
    fields: Omit<ReviewItem, "marked" | "flagged"> &
      Partial<Pick<ReviewItem, "marked" | "flagged">>,
  ): void {
    this.items.push({ marked: false, flagged: false, ...fields });
  }

  /** Step 1 for one repo: update what is safe, collect the rest as decisions. */
  syncRepo(path: string, fetched: boolean): void {
    const name = this.name(path);
    if (!fetched) {
      this.add("failed", name, "git fetch failed, offline or auth issue?");
      return;
    }
    const g = (...args: string[]) => git(path, ...args);

    const branch = g("rev-parse", "--abbrev-ref", "HEAD").out;
    const defaultBranch = detectDefaultBranch(path);
    if (!defaultBranch) {
      this.add(
        "skipped",
        name,
        `no default branch detected, currently on '${branch}'`,
      );
      return;
    }
    const remoteRef = `origin/${defaultBranch}`;
    if (
      !g("rev-parse", "--verify", "--quiet", `refs/remotes/${remoteRef}`).ok
    ) {
      this.add("skipped", name, `'${remoteRef}' not found`);
      return;
    }

    const onDefault = branch === defaultBranch;
    const localChanges = changedFiles(path);
    const hadNodeModules = existsSync(join(path, "node_modules"));
    const hasLocalDefault = g(
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${defaultBranch}`,
    ).ok;
    let ahead = 0;
    let behind = 1;
    if (hasLocalDefault) {
      [ahead = 0, behind = 0] = g(
        "rev-list",
        "--left-right",
        "--count",
        `${defaultBranch}...${remoteRef}`,
      )
        .out.split(/\s+/)
        .map(Number);
    }
    const before = hasLocalDefault ? g("rev-parse", defaultBranch).out : "";
    const where = onDefault ? "" : `, on '${branch}'`;
    let updated = false;

    if (ahead > 0 && behind > 0) {
      // Diverged: only a reset can fix it, and that is a decision for the review list.
      const detail = `'${defaultBranch}' has diverged from origin (${count(ahead, "local commit")}, ${count(behind, "remote commit")})${where}`;
      if (onDefault && localChanges.length > 0) {
        this.add("skipped", name, `${detail}, and local changes block a reset`);
      } else {
        const record = this.add("skipped", name, detail + this.reviewHint);
        this.item({
          kind: "reset",
          repo: name,
          repoPath: path,
          flagged: true,
          label: `Reset '${defaultBranch}' to origin (local commits are kept in a backup branch)`,
          defaultBranch,
          onDefault,
          record,
        });
      }
    } else if (behind > 0) {
      if (onDefault) {
        let overlap: string[] = [];
        if (localChanges.length > 0) {
          const incoming = new Set(
            g("diff", "--name-only", `${defaultBranch}..${remoteRef}`).lines,
          );
          overlap = localChanges.filter((f) => incoming.has(f));
        }
        if (overlap.length > 0) {
          const record = this.add(
            "skipped",
            name,
            `local changes touch ${count(overlap.length, "incoming file")}${this.reviewHint}`,
          );
          this.item({
            kind: "stash",
            repo: name,
            repoPath: path,
            label: `Stash local changes, update '${defaultBranch}', restore them (${overlap.length} overlapping)`,
            defaultBranch,
            overlap,
            record,
          });
        } else if (g("merge", "--ff-only", "--quiet", remoteRef).ok) {
          updated = true;
        } else {
          this.add("failed", name, `fast-forward of '${defaultBranch}' failed`);
        }
      } else if (
        g("fetch", "--quiet", "origin", `${defaultBranch}:${defaultBranch}`).ok
      ) {
        // Not checked out: move the branch without touching the working tree.
        updated = true;
      } else {
        this.add("failed", name, `could not update '${defaultBranch}'${where}`);
      }
    } else {
      const note =
        ahead > 0 ? `, ${count(ahead, "local commit")} not pushed` : "";
      this.add("current", name, `'${defaultBranch}'${note}${where}`);
    }

    if (updated) {
      const after = g("rev-parse", defaultBranch).out;
      const keep =
        onDefault && localChanges.length > 0 ? ", local changes kept" : "";
      this.add(
        "updated",
        name,
        `${before ? before.slice(0, 7) : "new"} -> ${after.slice(0, 7)}${where}${keep}`,
      );
      if (
        onDefault &&
        hadNodeModules &&
        before &&
        existsSync(join(path, "package.json"))
      ) {
        this.item({
          kind: "npm",
          repo: name,
          repoPath: path,
          label: "npm install",
          defaultBranch,
          before,
          after,
        });
      }
    }

    // Local branches: fully merged ones go right away, the rest are decisions.
    const worktreeBranches = new Set(
      g("worktree", "list", "--porcelain")
        .lines.map((l) => /^branch refs\/heads\/(.+)$/.exec(l)?.[1])
        .filter(Boolean),
    );
    const isFree = (b: string): boolean =>
      Boolean(b) &&
      b !== defaultBranch &&
      b !== branch &&
      !worktreeBranches.has(b);
    const merged = new Set(
      g(
        "branch",
        "--merged",
        defaultBranch,
        "--format=%(refname:short)",
      ).lines.filter(isFree),
    );
    // -D: --merged already checked them against the default branch, while -d
    // would check against HEAD or a (possibly pruned) upstream instead.
    for (const b of merged) this.deleteBranch(path, name, b, "-D");

    let currentInDefault = false;
    if (!onDefault && branch !== "HEAD") {
      currentInDefault =
        g("merge-base", "--is-ancestor", branch, defaultBranch).ok ||
        contentInDefault(path, branch, defaultBranch);
    }

    for (const ref of g(
      "for-each-ref",
      "--format=%(refname:short)|%(upstream:track)",
      "refs/heads",
    ).lines) {
      const [b = "", track] = ref.split("|", 2);
      if (!isFree(b) || merged.has(b)) continue;
      const gone = track === "[gone]";
      if (contentInDefault(path, b, defaultBranch)) {
        this.item({
          kind: "delete",
          repo: name,
          repoPath: path,
          marked: true,
          label: `Delete branch '${b}' (already in '${defaultBranch}'${gone ? ", upstream gone" : ""})`,
          defaultBranch,
          branch: b,
          inDefault: true,
        });
      } else if (gone) {
        const unique = Number(
          g("rev-list", "--count", `${defaultBranch}..${b}`).out,
        );
        this.item({
          kind: "delete",
          repo: name,
          repoPath: path,
          flagged: true,
          label: `Delete branch '${b}' (upstream gone, ${count(unique, "commit")} not in '${defaultBranch}')`,
          defaultBranch,
          branch: b,
          inDefault: false,
        });
      }
    }

    // Leaving the current branch for the default branch (only without local changes).
    if (!onDefault && branch !== "HEAD" && localChanges.length === 0) {
      this.item({
        kind: "switch",
        repo: name,
        repoPath: path,
        marked: currentInDefault,
        label: currentInDefault
          ? `Switch to '${defaultBranch}' and delete '${branch}' (already in '${defaultBranch}')`
          : `Switch to '${defaultBranch}' (leaves '${branch}', which has unmerged work)`,
        defaultBranch,
        branch,
        deleteBranch: currentInDefault,
      });
    }
  }

  private deleteBranch(
    path: string,
    name: string,
    branch: string,
    mode: "-d" | "-D",
  ): boolean {
    const sha = git(path, "rev-parse", "--short", branch).out;
    if (git(path, "branch", mode, "--quiet", branch).ok) {
      this.counts.cleaned++;
      line("Cleaned", name, `deleted '${branch}', was ${sha}`, "blue");
      return true;
    }
    this.add("failed", name, `could not delete '${branch}'`);
    return false;
  }

  /** Step 2 without the list: the entries a setting already decides. */
  split(): { run: ReviewItem[]; ask: ReviewItem[] } {
    const run: ReviewItem[] = [];
    const ask: ReviewItem[] = [];
    for (const item of this.items) {
      const setting =
        item.kind === "npm" ? this.options.installDeps : this.options.cleanup;
      if (setting === undefined) ask.push(item);
      // npm: every entry; cleanup: only what would be pre-marked.
      else if (setting && (item.kind === "npm" || item.marked)) run.push(item);
    }
    return { run, ask };
  }

  /** Step 3: runs the chosen entries, repo by repo in the order they were synced. */
  runAll(items: ReviewItem[]): void {
    const repoOrder = new Map(this.items.map((i, n) => [i.repo, n]));
    const kindOrder: ItemKind[] = ["stash", "reset", "switch", "delete", "npm"];
    const sorted = [...items].sort(
      (a, b) =>
        repoOrder.get(a.repo)! - repoOrder.get(b.repo)! ||
        kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind),
    );
    for (const item of sorted) this.run(item);
  }

  /** Runs one review entry. */
  run(item: ReviewItem): void {
    const { repo: name, repoPath: path, defaultBranch } = item;
    const g = (...args: string[]) => git(path, ...args);

    switch (item.kind) {
      case "npm": {
        installDeps(this, name, path);
        return;
      }
      case "stash": {
        const now = new Date();
        if (
          !g(
            "stash",
            "push",
            "-u",
            "--quiet",
            "-m",
            `sync-git-repos ${day(now)} ${time(now).slice(0, 5)}`,
          ).ok
        ) {
          this.add("failed", name, "could not stash local changes");
          return;
        }
        const before = g("rev-parse", "--short", "HEAD").out;
        const mergeOk = g(
          "merge",
          "--ff-only",
          "--quiet",
          `origin/${defaultBranch}`,
        ).ok;
        const popOk = g("stash", "pop", "--quiet").ok;
        if (!mergeOk) {
          this.add(
            "failed",
            name,
            popOk
              ? `could not update '${defaultBranch}', local changes restored`
              : "could not update, local changes are in 'git stash list'",
          );
        } else if (!popOk) {
          this.add(
            "failed",
            name,
            "updated, but restoring local changes conflicted, they are in 'git stash list'",
          );
        } else {
          this.replace(item.record);
          this.add(
            "updated",
            name,
            `${before} -> ${g("rev-parse", "--short", "HEAD").out}, local changes restored`,
          );
        }
        return;
      }
      case "reset": {
        const now = new Date();
        let backup = `backup/${defaultBranch}-${day(now)}`;
        if (g("show-ref", "--verify", "--quiet", `refs/heads/${backup}`).ok)
          backup += `-${time(now).replaceAll(":", "")}`;
        const old = g("rev-parse", "--short", defaultBranch).out;
        if (!g("branch", "--quiet", backup, defaultBranch).ok) {
          this.add(
            "failed",
            name,
            "could not create the backup branch, nothing was reset",
          );
          return;
        }
        const ok = item.onDefault
          ? g("reset", "--hard", "--quiet", `origin/${defaultBranch}`).ok
          : g(
              "branch",
              "--quiet",
              "-f",
              defaultBranch,
              `origin/${defaultBranch}`,
            ).ok;
        if (!ok) {
          this.add(
            "failed",
            name,
            `reset of '${defaultBranch}' failed, backup is '${backup}'`,
          );
          return;
        }
        this.counts.reset++;
        this.replace(item.record);
        line(
          "Reset",
          name,
          `'${defaultBranch}' ${old} -> ${g("rev-parse", "--short", defaultBranch).out}, backup: ${backup}`,
          "cyan",
        );
        this.add("updated", name, `'${defaultBranch}' matches origin again`);
        return;
      }
      case "switch": {
        if (!g("checkout", "--quiet", defaultBranch).ok) {
          this.add("failed", name, `could not switch to '${defaultBranch}'`);
          return;
        }
        this.counts.switched++;
        line(
          "Switched",
          name,
          `'${item.branch}' -> '${defaultBranch}'`,
          "cyan",
        );
        if (item.deleteBranch)
          this.deleteBranch(path, name, item.branch!, "-D");
        return;
      }
      case "delete": {
        this.deleteBranch(path, name, item.branch!, "-D");
        return;
      }
    }
  }

  /** Counts line plus the repos that still need attention. */
  summary(): void {
    const n = (s: ResultState): number =>
      this.results.filter((r) => r.state === s).length;
    const failed = n("failed");
    const skipped = n("skipped");
    let text = `Updated: ${n("updated")}, up to date: ${n("current")}, skipped: ${skipped}, failed: ${failed}`;
    if (this.counts.cleaned)
      text += `, branches deleted: ${this.counts.cleaned}`;
    if (this.counts.reset) text += `, reset: ${this.counts.reset}`;
    if (this.offline) text += `, online-only: ${this.offline}`;
    say();
    say(text, failed ? "red" : skipped ? "yellow" : "green");

    const attention = this.results.filter(
      (r) => r.state === "skipped" || r.state === "failed",
    );
    if (attention.length) {
      say();
      say("Needs attention:", "yellow");
      for (const r of attention)
        say(`  ${r.name}  (${r.detail})`, RESULT_COLORS[r.state]);
    }
  }
}

/** `git fetch --prune` for every repo, several at a time. Returns whether each worked. */
export async function fetchAll(
  repos: string[],
  parallel = 8,
): Promise<Map<string, boolean>> {
  const ok = new Map<string, boolean>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < repos.length) {
      const repo = repos[next++]!;
      ok.set(repo, (await gitAsync(repo, "fetch", "--quiet", "--prune")).ok);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(parallel, repos.length) }, worker),
  );
  return ok;
}

/** Files with local changes: modified, staged and untracked (repo-relative, forward slashes). */
export function changedFiles(path: string): string[] {
  return [
    ...new Set([
      ...git(path, "diff", "--name-only").lines,
      ...git(path, "diff", "--name-only", "--cached").lines,
      ...git(path, "ls-files", "--others", "--exclude-standard").lines,
    ]),
  ];
}

/**
 * Whether merging the branch into the default branch would change nothing,
 * i.e. its changes are already there (squash or rebase merged). Git 2.38+.
 */
export function contentInDefault(
  path: string,
  branch: string,
  defaultBranch: string,
): boolean {
  const merged = git(path, "merge-tree", "--write-tree", defaultBranch, branch);
  if (!merged.ok || merged.lines.length === 0) return false;
  return (
    merged.lines[0] === git(path, "rev-parse", `${defaultBranch}^{tree}`).out
  );
}

function installDeps(sync: Sync, name: string, path: string): void {
  const args = existsSync(join(path, "package-lock.json"))
    ? ["ci"]
    : ["install"];
  line("Installing", name, `npm ${args[0]}`, "cyan");
  // npm is a .cmd script on Windows, which only runs through a shell.
  // With a shell the command is one string (args plus shell is deprecated);
  // the arguments are fixed here, so nothing needs quoting.
  const opts = { cwd: path, stdio: "ignore" as const };
  const r =
    process.platform === "win32"
      ? spawnSync(`npm ${args[0]} --silent`, { ...opts, shell: true })
      : spawnSync("npm", [...args, "--silent"], opts);
  if (r.status === 0) line("Installed", name, "", "green");
  else sync.add("failed", name, `npm ${args[0]} failed`);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "2026-11-02", local time. */
function day(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "14:05:09", local time. */
function time(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The lines shown below the review list for an entry. */
export function preview(item: ReviewItem): string[] {
  const g = (...args: string[]) => git(item.repoPath, ...args);
  const d = item.defaultBranch;
  switch (item.kind) {
    case "stash":
      return [
        `Local changes in files that the update touches: ${item.overlap!.join(", ")}`,
        ...g("diff", "--stat", "HEAD", "--", ...item.overlap!).lines.map((l) =>
          l.trim(),
        ),
      ];
    case "reset":
      return [
        `Local commits on '${d}' that origin does not have (kept in the backup branch):`,
        ...g("log", "--oneline", "-n", "4", `origin/${d}..${d}`).lines.map(
          (l) => `  ${l}`,
        ),
      ];
    case "delete":
      return [
        item.inDefault
          ? `No changes compared to '${d}', everything is already in it.`
          : `Commits only on this branch, not in '${d}':`,
        ...(item.inDefault
          ? []
          : g("log", "--oneline", "-n", "4", `${d}..${item.branch}`).lines.map(
              (l) => `  ${l}`,
            )),
        `Last commit: ${g("log", "-1", "--format=%cr, %s", item.branch!).out}`,
      ];
    case "switch":
      return [
        `Currently on '${item.branch}'.`,
        item.deleteBranch
          ? "The branch is done and gets deleted after the switch."
          : `The branch is kept; it still has work that is not in '${d}'.`,
      ];
    case "npm": {
      const diff = g(
        "diff",
        "--stat",
        item.before!,
        item.after!,
        "--",
        "package.json",
        "package-lock.json",
      ).lines;
      return diff.length
        ? diff.map((l) => l.trim())
        : ["package.json and lockfile unchanged"];
    }
  }
}

/** The full diff for the `v` key, in git's pager. */
export function showDiff(item: ReviewItem): void {
  const d = item.defaultBranch;
  const args: Record<ItemKind, string[]> = {
    stash: ["diff", "HEAD", "--", ...(item.overlap ?? [])],
    reset: ["log", "--stat", `origin/${d}..${d}`],
    delete: ["log", "-p", `${d}..${item.branch}`],
    switch: ["log", "-p", `${d}..${item.branch}`],
    npm: [
      "diff",
      item.before ?? "",
      item.after ?? "",
      "--",
      "package.json",
      "package-lock.json",
    ],
  };
  gitInteractive(item.repoPath, ...args[item.kind]);
}

/** Folder segments of a repo name, for the review tree. */
export function repoSegments(repo: string): string[] {
  return repo.split(sep).filter(Boolean);
}
