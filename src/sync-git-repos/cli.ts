#!/usr/bin/env node
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pick } from "../lib/picker/index.ts";
import { isInteractive, plural, say } from "../lib/term.ts";
import { cloudOnlyRepos, findRepos } from "./repos.ts";
import {
  type ReviewItem,
  Sync,
  fetchAll,
  preview,
  repoSegments,
  showDiff,
} from "./sync.ts";

const HELP = `Usage: sync-git-repos [folder] [options]

Brings every Git repo below the folder (default: the current one) up to date
with its default branch. Decisions (deleting branches, switching, resets,
npm install) are collected into one list at the end.

Options:
      --cleanup          do the pre-marked branch entries without the list
      --no-cleanup       no branch entries at all
      --install-deps     npm install every updated repo that had node_modules
      --no-install-deps  never npm install
  -d, --max-depth <n>    only search n folder levels deep (1 = subfolders)
  -h, --help             show this help

Without --cleanup / --install-deps (or their --no- forms), these entries are
decided in the review list.`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      cleanup: { type: "boolean" },
      "install-deps": { type: "boolean" },
      "max-depth": { type: "string", short: "d" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    say(HELP);
    return 0;
  }
  if (positionals.length > 1) throw new Error("Only one folder, please.");
  const maxDepth = values["max-depth"] ? Number(values["max-depth"]) : Infinity;
  if (!(maxDepth >= 1))
    throw new Error("--max-depth needs a number of at least 1.");

  const root = resolve(positionals[0] ?? ".");
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`Folder not found: ${root}`);

  const repos = findRepos(root, maxDepth);
  if (repos.length === 0) {
    say(`No git repos found under ${root}.`, "yellow");
    return 0;
  }

  const sync = new Sync(root, {
    cleanup: values.cleanup,
    installDeps: values["install-deps"],
  });

  // .git not (fully) local: skip silently, nothing gets downloaded.
  const cloud = await cloudOnlyRepos(repos);
  sync.offline = cloud.size;
  const local = repos.filter((r) => !cloud.has(r));

  say();
  say(
    `Syncing ${plural(repos.length, "repo", "repos")} under ${root}:`,
    "cyan",
  );
  say();

  // Step 1: sync, no questions. Fetching runs in parallel, the rest in order.
  const fetched = await fetchAll(local);
  for (const repo of local) sync.syncRepo(repo, fetched.get(repo) ?? false);

  // Step 2: decisions settled by an option run directly, the rest go into one list.
  const { run, ask } = sync.split();
  if (ask.length > 0) {
    say();
    if (!isInteractive()) {
      say(
        `${ask.length} open decisions skipped, no interactive terminal.`,
        "gray",
      );
    } else {
      const repoCount = new Set(ask.map((i) => i.repo)).size;
      const result = await pick<ReviewItem>({
        items: ask,
        title: `Review: ${plural(ask.length, "decision", "decisions")} in ${plural(repoCount, "repo", "repos")}`,
        describe: (i) => ({
          text: `${i.repo}: ${i.label}`,
          label: i.label,
          path: repoSegments(i.repo),
          marked: i.marked,
        }),
        flag: (i) => i.flagged,
        flagLabel: "needs care",
        noFlagKey: true,
        tree: true,
        startInTree: true,
        preview,
        actions: { v: { label: "full diff", run: showDiff } },
      });
      if (result.cancelled)
        say(
          run.length
            ? "Review cancelled, only the entries set by options run."
            : "Review cancelled, nothing changed.",
          "gray",
        );
      else run.push(...result.items);
    }
  }

  // Step 3: run what was marked, repo by repo.
  if (run.length > 0) {
    say();
    sync.runAll(run);
  }

  sync.summary();
  return sync.results.some((r) => r.state === "failed") ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  say();
  say(`Error: ${(error as Error).message}`, "red");
  process.exitCode = 1;
}
