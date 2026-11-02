#!/usr/bin/env node
import { parseArgs } from "node:util";
import { git, gitInteractive } from "../lib/git.ts";
import { pick } from "../lib/picker/index.ts";
import { ask, isInteractive, paint, plural, say } from "../lib/term.ts";
import {
  type BranchInfo,
  type Commit,
  type Identity,
  type PlanEntry,
  backupRef,
  fetchRefs,
  inspect,
  isForeign,
  makePlan,
  moveBranch,
  push,
  readIdentity,
  rewrite,
  rewriteCount,
  signProbe,
  checkRepo,
} from "./adopt.ts";

const HELP = `Usage: git-adopt [options]   (or: git adopt)

Makes you the author of other people's commits on the current branch (e.g.
commits made by an AI agent) and signs them with your key. Commits you already
adopted keep their hash; the trees stay exactly the same, so there are no
conflicts and merge commits stay merges.

Options:
  -b, --base <ref>      compare against this ref (default: origin's default branch)
  -a, --author <email>  pre-mark only commits by this author
      --no-fetch        do not fetch the default branch and upstream first
  -n, --dry-run         only show what would be rewritten
  -y, --yes             no list, no question: adopt the pre-marked commits
      --push            push with --force-with-lease afterwards without asking
      --no-push         never push
  -h, --help            show this help (as "git adopt", only -h works)

Pre-marked are the commits where you are not the author or committer (your
identity comes from user.name and user.email).`;

const STEP: Record<PlanEntry["step"], [string, Parameters<typeof paint>[0]]> = {
  keep: ["keep   ", "gray"],
  adopt: ["adopt  ", "green"],
  resign: ["re-sign", "yellow"],
};

const short = (hash: string): string => hash.slice(0, 7);
const who = (c: Commit): string => `${c.authorName} <${c.authorEmail}>`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      base: { type: "string", short: "b" },
      author: { type: "string", short: "a" },
      fetch: { type: "boolean", default: true },
      "dry-run": { type: "boolean", short: "n" },
      yes: { type: "boolean", short: "y" },
      push: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    say(HELP);
    return 0;
  }
  if (positionals.length > 0)
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  const repo = process.cwd();
  const dryRun = Boolean(values["dry-run"]);
  const interactive = isInteractive() && !values.yes;
  if (!values.yes && !dryRun && !isInteractive())
    throw new Error("No interactive terminal: use --yes (or --dry-run).");

  const branch = checkRepo(repo);
  const me = readIdentity(repo);
  if (values.fetch && !fetchRefs(repo, branch))
    say("Fetch failed, working with the refs as they are.", "yellow");

  const info = inspect(repo, values.base);
  const up = info.upstream;
  if (up?.trackingHash && !isAncestor(repo, up.trackingHash, info.head))
    throw new Error(
      `'${branch}' is missing commits from ${shortRef(up.trackingRef)}, pull first.`,
    );

  say();
  say(
    `${branch} → base ${info.base} (merge-base ${short(info.mergeBase)}), ${plural(info.commits.length, "commit", "commits")}`,
    "cyan",
  );
  say(`Identity: ${me.name} <${me.email}>`, "gray");
  if (info.behindBase > 0)
    say(
      `Note: ${info.base} has ${plural(info.behindBase, "commit", "commits")} that '${branch}' does not (no rebase is done).`,
      "gray",
    );
  if (info.commits.length === 0) {
    say("No commits on this branch beyond the base, nothing to do.", "green");
    return 0;
  }

  const foreign = (c: Commit): boolean => isForeign(c, me, values.author);
  let chosen = info.commits.filter(foreign);
  if (interactive && !dryRun) {
    const picked = await choose(repo, info, me, foreign);
    if (!picked) {
      say("Cancelled, nothing changed.", "gray");
      return 0;
    }
    chosen = picked;
  }

  const plan = makePlan(info.commits, new Set(chosen.map((c) => c.hash)));
  const count = rewriteCount(plan);
  if (count === 0) {
    say("Nothing to adopt, every commit stays as it is.", "green");
    return 0;
  }
  say();
  for (const { commit, step } of plan) {
    const [label, color] = STEP[step];
    say(
      `  ${paint(color, label)}  ${short(commit.hash)}  ${commit.subject}  ${paint("gray", commit.authorName)}`,
    );
  }
  say();
  if (dryRun) {
    say(
      `Dry run: would rewrite ${plural(count, "commit", "commits")}, nothing changed.`,
      "cyan",
    );
    return 0;
  }
  if (interactive) {
    const answer = await ask(
      `Rewrite ${plural(count, "commit", "commits")}? [y/N] `,
    );
    if (!/^(y|yes|j|ja)$/i.test(answer)) {
      say("Nothing changed.", "gray");
      return 0;
    }
  }

  const probe = signProbe(repo);
  if (probe)
    throw new Error(`Signing does not work, nothing changed:\n${probe}`);

  const newHead = rewrite(repo, plan, me);
  moveBranch(repo, branch, info.head, newHead);
  say(
    `✓ ${branch}: ${short(info.head)} → ${short(newHead)} (old state: ${backupRef(branch)})`,
    "green",
  );
  say(`  Undo with: git reset --keep ${backupRef(branch)}`, "gray");

  if (!up) {
    if (values.push) say("No upstream branch, not pushed.", "yellow");
    return 0;
  }
  let doPush = values.push;
  if (doPush === undefined && interactive) {
    const answer = await ask(
      `Push to ${shortRef(up.trackingRef)} with --force-with-lease? [Y/n] `,
    );
    doPush = !/^(n|no|nein)$/i.test(answer);
  }
  if (!doPush) return 0;
  if (!push(repo, up, newHead)) {
    say("Push failed, the rewritten branch is only local.", "red");
    return 1;
  }
  say("✓ pushed", "green");
  return 0;
}

/** The review list; undefined when cancelled. */
async function choose(
  repo: string,
  info: BranchInfo,
  me: Identity,
  foreign: (c: Commit) => boolean,
): Promise<Commit[] | undefined> {
  const order = new Map(info.commits.map((c, i) => [c.hash, i]));
  const width = String(info.commits.length).length;
  const result = await pick<Commit>({
    items: info.commits,
    title: `Adopt commits on ${info.branch} (you: ${me.email}) · [g] groups by author`,
    describe: (c) => {
      const text = `${short(c.hash)} ${c.subject}  · ${c.authorName}`;
      // The tree sorts by label, the number keeps the commit order.
      const n = String(order.get(c.hash)! + 1).padStart(width, "0");
      return {
        text,
        label: `${n} ${short(c.hash)} ${c.subject}`,
        path: [who(c)],
        marked: foreign(c),
      };
    },
    flag: (c) => isForeign(c, me),
    flagLabel: "not yours",
    tree: true,
    preview: (c) => preview(repo, c),
    actions: {
      s: {
        label: "git show",
        run: (c) => void gitInteractive(repo, "show", "--stat", "-p", c.hash),
      },
    },
  });
  return result.cancelled ? undefined : result.items;
}

const SIGNATURE: Record<string, string> = {
  G: "good",
  U: "good, unknown validity",
  X: "good, expired",
  Y: "good, expired key",
  R: "revoked key",
  E: "cannot be checked",
  B: "BAD",
  N: "none",
};

function preview(repo: string, c: Commit): string[] {
  const [sig = "N", signer = "", key = ""] = git(
    repo,
    "log",
    "--no-show-signature",
    "-1",
    "--format=%G?%x1f%GS%x1f%GK",
    c.hash,
  ).out.split("\x1f");
  const signedBy = [signer, key].filter(Boolean).join(" ");
  // Without gpg.ssh.allowedSignersFile, git reports SSH signatures as missing.
  const unchecked =
    (sig === "N" || sig === "E") &&
    /^gpgsig /m.test(git(repo, "cat-file", "commit", c.hash).out);
  const signature = unchecked
    ? "present, not checked (set gpg.ssh.allowedSignersFile to check it)"
    : `${SIGNATURE[sig] ?? sig}${signedBy ? ` (${signedBy})` : ""}`;
  return [
    `Author:    ${who(c)}`,
    `Committer: ${c.committerName} <${c.committerEmail}>`,
    `Signature: ${signature}`,
    c.parents.length > 1
      ? `Merge of ${plural(c.parents.length, "parent", "parents")}`
      : (git(repo, "show", "--shortstat", "--format=", c.hash).out.trim() ??
        ""),
  ];
}

function isAncestor(repo: string, ancestor: string, of: string): boolean {
  return git(repo, "merge-base", "--is-ancestor", ancestor, of).ok;
}

function shortRef(ref: string): string {
  return ref.replace(/^refs\/remotes\//, "");
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  say();
  say(`Error: ${(error as Error).message}`, "red");
  process.exitCode = 1;
}
