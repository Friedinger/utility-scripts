import { execFile } from "node:child_process";
import { lstat, readFile, readdir, readlink, rm } from "node:fs/promises";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import trash from "trash";
import {
  caseInsensitivePaths,
  hasWildcard,
  pathKey,
  wildcardToRegExp,
} from "../lib/paths.ts";

/** One tracked config and the entry file(s) in the state directory that record it. */
export interface TrackedConfig {
  path: string;
  entries: string[];
}

/** Asks `mise doctor` where mise keeps its state and returns the tracked-configs folder. */
export async function findStateDir(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("mise", ["doctor", "--json"], {
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string };
    if (failure.code === "ENOENT")
      throw new Error("mise not found on PATH.", { cause: error });
    // mise doctor exits 1 as soon as it finds any problem, but still prints the JSON.
    if (!failure.stdout?.trim())
      throw new Error(`mise doctor --json failed: ${failure.message}`, {
        cause: error,
      });
    stdout = failure.stdout;
  }
  const state = (JSON.parse(stdout) as { dirs?: { state?: string } }).dirs
    ?.state;
  if (!state) throw new Error("mise doctor --json returned no dirs.state.");
  return join(state, "tracked-configs");
}

/**
 * Reads the tracked-configs folder. mise writes each entry as a symlink to the
 * config on unix and, because symlinks need a privilege on Windows, as a plain
 * file holding the path there. Anything else is not an entry and is skipped.
 */
export async function readTracked(
  stateDir: string,
  platform = process.platform,
): Promise<TrackedConfig[]> {
  const byPath = new Map<string, TrackedConfig>();
  for (const name of await readdir(stateDir)) {
    const entry = join(stateDir, name);
    const info = await lstat(entry);
    let target: string;
    if (info.isSymbolicLink())
      target = resolve(stateDir, await readlink(entry));
    else if (info.isFile() && platform === "win32")
      target = (await readFile(entry, "utf8")).trim();
    else continue;
    if (!target) continue;
    const tracked = byPath.get(target);
    if (tracked) tracked.entries.push(entry);
    else byPath.set(target, { path: target, entries: [entry] });
  }
  return [...byPath.values()].sort((a, b) =>
    a.path.localeCompare(b.path, undefined, { sensitivity: "base" }),
  );
}

/** Like mise itself: an entry is only alive while it points at a regular file. */
export function isMissing(path: string): boolean {
  return !statSync(path, { throwIfNoEntry: false })?.isFile();
}

/** Last-modified date and the first lines of the config, for the list preview. */
export function preview(path: string): string[] {
  const info = statSync(path, { throwIfNoEntry: false });
  if (!info?.isFile()) {
    const lines = ["(file not found)"];
    if (!statSync(dirname(path), { throwIfNoEntry: false }))
      lines.push("(folder gone too)");
    return lines;
  }
  const buffer = Buffer.alloc(2048);
  const fd = openSync(path, "r");
  let read: number;
  try {
    read = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  const head = buffer.toString("utf8", 0, read).split(/\r?\n/).slice(0, 4);
  return [`modified ${formatDate(info.mtime)}`, ...head];
}

function formatDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Picks the tracked paths that match any pattern (exact path, or wildcards
 * `*` and `?`). Also returns the patterns that matched nothing.
 */
export function matchPatterns(
  tracked: string[],
  patterns: string[],
  caseInsensitive = caseInsensitivePaths,
): { matched: string[]; unmatched: string[] } {
  const hit = new Set<string>();
  const unmatched: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    const regex = hasWildcard(pattern)
      ? wildcardToRegExp(pattern, caseInsensitive)
      : undefined;
    const key = pathKey(pattern, caseInsensitive);
    const hits = tracked.filter(
      (t) => pathKey(t, caseInsensitive) === key || regex?.test(t),
    );
    if (hits.length === 0) unmatched.push(pattern);
    for (const h of hits) hit.add(h);
  }
  return { matched: tracked.filter((t) => hit.has(t)), unmatched };
}

/**
 * Removes the entry files of one tracked config, to the trash or for good.
 * Only the entries are touched, never the config they point at; this is
 * checked afterwards, since trashing a symlink must move the link itself.
 */
export async function forget(
  config: TrackedConfig,
  mode: "trash" | "permanent",
): Promise<void> {
  const existedBefore = !isMissing(config.path);
  for (const entry of config.entries) {
    if (mode === "trash") await trash(entry, { glob: false });
    else await rm(entry, { force: true });
  }
  for (const entry of config.entries) {
    if (await lstat(entry).catch(() => undefined))
      throw new Error("entry is still there");
  }
  if (existedBefore && isMissing(config.path)) {
    throw new Error(
      `the config itself is gone too, restore it from the trash: ${config.path}`,
    );
  }
}
