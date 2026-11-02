#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pick } from "../lib/picker/index.ts";
import { ask, isInteractive, plural, say } from "../lib/term.ts";
import {
  findStateDir,
  forget,
  isMissing,
  matchPatterns,
  preview,
  readTracked,
} from "./tracked.ts";

const HELP = `Usage: mise-forget [path...] [options]

Removes entries from mise's tracked-configs list. Without paths and without
--missing, opens an interactive list to mark the entries.

Arguments:
  path              tracked config path(s) to remove; * and ? are wildcards

Options:
  -m, --missing     only entries whose config file no longer exists
                    (alone: all of them; with paths: only those matches)
  -y, --yes         skip the confirmation (needs a path or --missing)
      --permanent   delete instead of moving to the trash
  -n, --dry-run     only show what would be removed
      --state-dir   use this tracked-configs folder instead of asking mise
  -h, --help        show this help`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      missing: { type: "boolean", short: "m" },
      yes: { type: "boolean", short: "y" },
      force: { type: "boolean" },
      permanent: { type: "boolean" },
      "dry-run": { type: "boolean", short: "n" },
      "state-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    say(HELP);
    return 0;
  }
  const yes = Boolean(values.yes || values.force);
  const dryRun = Boolean(values["dry-run"]);
  const interactive = positionals.length === 0 && !values.missing;
  if (yes && interactive) throw new Error("--yes needs a path or --missing.");

  const stateDir = values["state-dir"] ?? (await findStateDir());
  const tracked = await readTracked(stateDir).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new Error(`Folder not found: ${stateDir}`);
      throw error;
    },
  );
  if (tracked.length === 0) {
    say("No tracked configs found.");
    return 0;
  }

  // Work out what to remove.
  let targets = tracked;
  let unmatched: string[] = [];
  if (interactive) {
    if (!isInteractive())
      throw new Error(
        "The list needs an interactive terminal; pass a path or --missing.",
      );
    const result = await pick({
      items: tracked,
      title: `Tracked configs (${tracked.length})`,
      describe: (t) => ({ text: t.path }),
      flag: (t) => isMissing(t.path),
      flagLabel: "missing",
      tree: true,
      preview: (t) => preview(t.path),
    });
    if (result.cancelled) {
      say("Aborted, nothing removed.");
      return 0;
    }
    targets = result.items;
    if (targets.length === 0) {
      say("Nothing marked, nothing removed.");
      return 0;
    }
  } else {
    if (positionals.length) {
      const match = matchPatterns(
        tracked.map((t) => t.path),
        positionals,
      );
      unmatched = match.unmatched;
      for (const u of unmatched) say(`Not in the list: ${u}`, "red");
      const keep = new Set(match.matched);
      targets = targets.filter((t) => keep.has(t.path));
    }
    if (values.missing) targets = targets.filter((t) => isMissing(t.path));
    if (targets.length === 0) {
      say("Nothing to remove.");
      return unmatched.length ? 1 : 0;
    }
  }

  // Always show the final list before removing.
  say();
  say(
    `About to remove ${plural(targets.length, "entry", "entries")}:`,
    "yellow",
  );
  say();
  for (const t of targets)
    say(`  ${t.path}` + (isMissing(t.path) ? "  (missing)" : ""));

  let mode: "trash" | "permanent" = values.permanent ? "permanent" : "trash";
  if (!yes && !dryRun) {
    say();
    if (!isInteractive())
      throw new Error(
        "Cannot ask for confirmation without a terminal; pass --yes.",
      );
    let ok: boolean;
    if (mode === "permanent") {
      ok = /^(y|yes)$/i.test(
        await ask(`Permanently remove ${targets.length}? (y/N) `),
      );
    } else {
      const answer = (
        await ask("[T]rash (default) / [P]ermanent / [N]o ")
      ).toLowerCase();
      ok = /^(t|trash)?$/.test(answer) || /^(p|permanent)$/.test(answer);
      if (/^(p|permanent)$/.test(answer)) mode = "permanent";
    }
    if (!ok) {
      say("Aborted, nothing removed.");
      return 0;
    }
  }

  // Remove one entry at a time, so a failure does not stop the rest.
  say();
  if (dryRun) {
    const how = mode === "trash" ? "move to the trash" : "delete for good";
    for (const t of targets) say(`Would ${how}: ${t.path}`);
    return unmatched.length ? 1 : 0;
  }
  let removed = 0;
  let failed = 0;
  for (const t of targets) {
    try {
      await forget(t, mode);
      say(`Removed: ${t.path}`, "green");
      removed++;
    } catch (error) {
      say(`Failed:  ${t.path} (${(error as Error).message})`, "red");
      failed++;
    }
  }
  say();
  say(`Removed: ${removed}, failed: ${failed}`, failed ? "red" : "green");
  return failed || unmatched.length ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  say();
  say(`Error: ${(error as Error).message}`, "red");
  process.exitCode = 1;
}
