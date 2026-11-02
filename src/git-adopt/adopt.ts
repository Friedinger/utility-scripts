/**
 * Everything git-adopt does to a repo, without terminal UI: find the branch's
 * commits, decide which to rewrite, and rewrite them with `git commit-tree`.
 *
 * Rewritten commits keep their tree, so there are no conflicts, merges stay
 * merges, and the working tree and index are never touched. Commits before
 * the first one that needs a change keep their hash.
 */
import { existsSync } from "node:fs";
import {
  detectDefaultBranch,
  git,
  gitInteractive,
  gitWith,
} from "../lib/git.ts";

export interface Identity {
  name: string;
  email: string;
}

export interface Commit {
  hash: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  subject: string;
}

/**
 * keep: unchanged, same hash · adopt: you become the author, signed by you ·
 * resign: author stays, new parents, so you commit and sign it again.
 */
export type Step = "keep" | "adopt" | "resign";

export interface PlanEntry {
  commit: Commit;
  step: Step;
}

export interface Upstream {
  remote: string;
  /** The branch on the remote, e.g. refs/heads/feature/x. */
  mergeRef: string;
  /** Remote-tracking ref, e.g. refs/remotes/origin/feature/x. */
  trackingRef: string;
  /** Where the remote-tracking ref points, empty if it does not exist. */
  trackingHash: string;
}

export interface BranchInfo {
  branch: string;
  head: string;
  /** What the branch is compared against, e.g. origin/main. */
  base: string;
  mergeBase: string;
  /** How many commits the base has that the branch does not. */
  behindBase: number;
  upstream?: Upstream;
  commits: Commit[];
}

const SEP = "\x1f";

/** Name and email from the Git config; throws if one is missing. */
export function readIdentity(repo: string): Identity {
  const name = git(repo, "config", "user.name").out;
  const email = git(repo, "config", "user.email").out;
  if (!name || !email)
    throw new Error(
      "Set user.name and user.email in your Git config first, they are used as the new author.",
    );
  return { name, email };
}

/** Throws unless `repo` is inside a work tree on a branch with nothing in progress. */
export function checkRepo(repo: string): string {
  if (!git(repo, "rev-parse", "--is-inside-work-tree").ok)
    throw new Error("Not inside a Git repo.");
  const branch = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (!branch.ok)
    throw new Error("HEAD is detached, switch to a branch first.");
  const busy = [
    ["rebase-merge", "a rebase"],
    ["rebase-apply", "a rebase"],
    ["MERGE_HEAD", "a merge"],
    ["CHERRY_PICK_HEAD", "a cherry-pick"],
    ["REVERT_HEAD", "a revert"],
    ["BISECT_LOG", "a bisect"],
  ];
  for (const [file, what] of busy) {
    const path = git(
      repo,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      file!,
    ).out;
    if (path && existsSync(path))
      throw new Error(`${what} is in progress, finish or abort it first.`);
  }
  return branch.out;
}

/** The branch's upstream, if it has one. */
export function findUpstream(
  repo: string,
  branch: string,
): Upstream | undefined {
  const remote = git(repo, "config", `branch.${branch}.remote`).out;
  const mergeRef = git(repo, "config", `branch.${branch}.merge`).out;
  if (!remote || remote === "." || !mergeRef) return undefined;
  const tracking = git(
    repo,
    "rev-parse",
    "--symbolic-full-name",
    `${branch}@{upstream}`,
  ).out;
  const trackingRef =
    tracking ||
    `refs/remotes/${remote}/${mergeRef.replace(/^refs\/heads\//, "")}`;
  const trackingHash = git(
    repo,
    "rev-parse",
    "--verify",
    "--quiet",
    trackingRef,
  ).out;
  return { remote, mergeRef, trackingRef, trackingHash };
}

/**
 * Fetches the default branch (and the branch's upstream), so the base and the
 * lease for the push are current. Returns false if a fetch failed.
 */
export function fetchRefs(repo: string, branch: string): boolean {
  let ok = true;
  const remote = git(repo, "remote").lines.includes("origin");
  const def = remote ? detectDefaultBranch(repo) : undefined;
  if (def) ok = gitInteractive(repo, "fetch", "--quiet", "origin", def) && ok;
  const up = findUpstream(repo, branch);
  if (up)
    ok =
      gitInteractive(
        repo,
        "fetch",
        "--quiet",
        up.remote,
        up.mergeRef.replace(/^refs\/heads\//, ""),
      ) && ok;
  return ok;
}

/** Picks the base: the given ref, else origin's default branch. */
export function resolveBase(repo: string, base?: string): string {
  if (base) {
    if (!git(repo, "rev-parse", "--verify", "--quiet", `${base}^{commit}`).ok)
      throw new Error(`Base '${base}' not found.`);
    return base;
  }
  const def = detectDefaultBranch(repo);
  const candidates = def
    ? [`origin/${def}`, def]
    : ["origin/main", "origin/master", "main", "master"];
  const found = candidates.find(
    (c) => git(repo, "rev-parse", "--verify", "--quiet", `${c}^{commit}`).ok,
  );
  if (!found)
    throw new Error("Could not find the default branch, give one with --base.");
  return found;
}

/** Everything about the current branch git-adopt needs. */
export function inspect(repo: string, base?: string): BranchInfo {
  const branch = checkRepo(repo);
  const head = git(repo, "rev-parse", "HEAD").out;
  const baseRef = resolveBase(repo, base);
  const mergeBase = git(repo, "merge-base", "HEAD", baseRef);
  if (!mergeBase.ok)
    throw new Error(`'${branch}' has no common history with '${baseRef}'.`);
  const behindBase = Number(
    git(repo, "rev-list", "--count", `HEAD..${baseRef}`).out || 0,
  );
  const upstream = findUpstream(repo, branch);
  return {
    branch,
    head,
    base: baseRef,
    mergeBase: mergeBase.out,
    behindBase,
    ...(upstream && { upstream }),
    commits: listCommits(repo, `${mergeBase.out}..HEAD`),
  };
}

/** Commits in `range`, oldest first, parents always before their children. */
export function listCommits(repo: string, range: string): Commit[] {
  const format = ["%H", "%P", "%an", "%ae", "%cn", "%ce", "%s"].join(SEP);
  return git(
    repo,
    "log",
    // log.showSignature would mix the signature check into the output.
    "--no-show-signature",
    "--topo-order",
    "--reverse",
    `--format=${format}`,
    range,
  ).lines.map((line) => {
    const [hash, parents, an, ae, cn, ce, subject] = line.split(SEP);
    return {
      hash: hash!,
      parents: parents ? parents.split(" ") : [],
      authorName: an!,
      authorEmail: ae!,
      committerName: cn!,
      committerEmail: ce!,
      subject: subject ?? "",
    };
  });
}

const same = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/**
 * Whether a commit is pre-marked: by default when you are not its author or
 * committer (the signature does not matter, others sign too); with `author`,
 * only commits by that author.
 */
export function isForeign(c: Commit, me: Identity, author?: string): boolean {
  if (author) return same(c.authorEmail, author) && !same(author, me.email);
  return !same(c.authorEmail, me.email) || !same(c.committerEmail, me.email);
}

/**
 * Decides per commit: the marked ones are adopted, every commit with a
 * rewritten parent is signed again, the rest keeps its hash.
 */
export function makePlan(commits: Commit[], adopt: Set<string>): PlanEntry[] {
  const changed = new Set<string>();
  return commits.map((commit) => {
    let step: Step = "keep";
    if (adopt.has(commit.hash)) step = "adopt";
    else if (commit.parents.some((p) => changed.has(p))) step = "resign";
    if (step !== "keep") changed.add(commit.hash);
    return { commit, step };
  });
}

/** Number of commits a plan rewrites. */
export function rewriteCount(plan: PlanEntry[]): number {
  return plan.filter((e) => e.step !== "keep").length;
}

/**
 * Tries to sign a throwaway commit (stored nowhere), so a broken signing setup
 * shows up before anything is rewritten. Returns the error, if any.
 */
export function signProbe(repo: string): string | undefined {
  const r = gitWith(
    repo,
    {},
    "commit-tree",
    "-S",
    "-m",
    "git-adopt signing probe",
    "HEAD^{tree}",
  );
  return r.ok ? undefined : r.err || "signing failed";
}

interface RawCommit {
  tree: string;
  /** "<unix seconds> <+hhmm>" */
  authorDate: string;
  authorName: string;
  authorEmail: string;
  encoding?: string;
  message: string;
}

/** Reads the parts of a commit object that are carried over, byte for byte. */
function readRaw(repo: string, hash: string): RawCommit {
  const raw = gitWith(repo, { raw: true }, "cat-file", "commit", hash).out;
  const split = raw.indexOf("\n\n");
  const head = split < 0 ? raw : raw.slice(0, split);
  const message = split < 0 ? "" : raw.slice(split + 2);
  const header = (name: string): string | undefined =>
    head
      .split("\n")
      .find((l) => l.startsWith(name + " "))
      ?.slice(name.length + 1);
  const author = /^(.*) <(.*)> (\d+ [+-]\d{4})$/.exec(header("author") ?? "");
  const tree = header("tree");
  if (!author || !tree) throw new Error(`Could not read commit ${hash}.`);
  const encoding = header("encoding");
  return {
    tree,
    authorName: author[1]!,
    authorEmail: author[2]!,
    authorDate: author[3]!,
    ...(encoding && { encoding }),
    message,
  };
}

/**
 * Writes the new commits for `plan` and returns the new head (the old one if
 * nothing changes). Moves no refs.
 */
export function rewrite(repo: string, plan: PlanEntry[], me: Identity): string {
  const map = new Map<string, string>();
  let head = plan.at(-1)?.commit.hash ?? "";
  for (const { commit, step } of plan) {
    if (step === "keep") {
      head = commit.hash;
      continue;
    }
    const raw = readRaw(repo, commit.hash);
    const adopt = step === "adopt";
    const parents = commit.parents.flatMap((p) => ["-p", map.get(p) ?? p]);
    const r = gitWith(
      repo,
      {
        input: raw.message,
        showErrors: true,
        env: {
          GIT_AUTHOR_NAME: adopt ? me.name : raw.authorName,
          GIT_AUTHOR_EMAIL: adopt ? me.email : raw.authorEmail,
          GIT_AUTHOR_DATE: raw.authorDate,
          GIT_COMMITTER_NAME: me.name,
          GIT_COMMITTER_EMAIL: me.email,
          GIT_COMMITTER_DATE: undefined,
        },
      },
      ...(raw.encoding ? ["-c", `i18n.commitEncoding=${raw.encoding}`] : []),
      "commit-tree",
      "-S",
      ...parents,
      "-F",
      "-",
      raw.tree,
    );
    if (!r.ok || !r.out)
      throw new Error(`Could not rewrite ${commit.hash.slice(0, 7)}.`);
    map.set(commit.hash, r.out);
    head = r.out;
  }
  return head;
}

export const backupRef = (branch: string): string =>
  `refs/adopt/backup/${branch}`;

/**
 * Points the branch at `newHead`, only if it still is at `oldHead`, and keeps
 * the old head in a backup ref.
 */
export function moveBranch(
  repo: string,
  branch: string,
  oldHead: string,
  newHead: string,
): void {
  // Backup first, so the undo hint never points to a ref that is missing.
  const backup = git(
    repo,
    "update-ref",
    "-m",
    "git-adopt",
    backupRef(branch),
    oldHead,
  );
  if (!backup.ok)
    throw new Error(
      `Could not create ${backupRef(branch)}, nothing changed: ${backup.err}`,
    );
  const moved = git(
    repo,
    "update-ref",
    "-m",
    "git-adopt",
    `refs/heads/${branch}`,
    newHead,
    oldHead,
  );
  if (!moved.ok)
    throw new Error(
      `Could not move '${branch}': ${moved.err || "it changed meanwhile"}`,
    );
}

/**
 * Pushes the branch with a lease on where its upstream was before: if
 * someone pushed in the meantime, the push is refused.
 */
export function push(repo: string, up: Upstream, newHead: string): boolean {
  return gitInteractive(
    repo,
    "push",
    "--quiet",
    `--force-with-lease=${up.mergeRef}:${up.trackingHash}`,
    up.remote,
    `${newHead}:${up.mergeRef}`,
  );
}
