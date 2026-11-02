import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathKey } from "../lib/paths.ts";

/**
 * Git repos below `root`, sorted by path. Does not descend into repos,
 * `node_modules`, hidden folders (name starting with a dot) or symlinks.
 * `maxDepth` 1 means only the direct subfolders.
 */
export function findRepos(root: string, maxDepth = Infinity): string[] {
  const repos: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    for (const e of entries) {
      if (
        !e.isDirectory() ||
        e.name === "node_modules" ||
        e.name.startsWith(".")
      )
        continue;
      const full = join(dir, e.name);
      if (existsSync(join(full, ".git"))) repos.push(full);
      else if (depth > 1) walk(full, depth - 1);
    }
  };
  walk(root, maxDepth);
  return repos;
}

/** OneDrive folders from the environment (Windows sets these). */
function oneDriveRoots(): string[] {
  const env = process.env;
  return [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter(
    (p): p is string => Boolean(p),
  );
}

// Offline | RecallOnOpen | RecallOnDataAccess: an OneDrive placeholder whose
// content is not on disk. Reads the repo paths from stdin and prints those
// where the folder or anything in .git is such a placeholder.
const CLOUD_CHECK = String.raw`
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$mask = 0x1000 -bor 0x40000 -bor 0x400000
foreach ($p in [Console]::In.ReadToEnd() -split "\r?\n") {
  if (-not $p) { continue }
  $cloud = $false
  try {
    $dir = Get-Item -LiteralPath $p -Force
    $git = Get-Item -LiteralPath (Join-Path $p '.git') -Force
    $cloud = (([int]$dir.Attributes -bor [int]$git.Attributes) -band $mask) -ne 0
    if (-not $cloud -and $git -is [IO.DirectoryInfo]) {
      foreach ($i in $git.EnumerateFileSystemInfos('*', 'AllDirectories')) {
        if ([int]$i.Attributes -band $mask) { $cloud = $true; break }
      }
    }
  } catch { }
  if ($cloud) { $p }
}`;

/**
 * Repos whose folder or `.git` is not fully on disk (OneDrive online-only).
 * Git would download them, so they are skipped. Windows only, and only asks
 * PowerShell when a repo is inside an OneDrive folder at all.
 */
export async function cloudOnlyRepos(repos: string[]): Promise<Set<string>> {
  if (process.platform !== "win32") return new Set();
  const roots = oneDriveRoots().map((r) => pathKey(r, true));
  const candidates = repos.filter((r) =>
    roots.some((root) => pathKey(r, true).startsWith(root)),
  );
  if (candidates.length === 0) return new Set();
  const child = promisify(execFile)(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", CLOUD_CHECK],
    { windowsHide: true },
  );
  child.child.stdin?.end(candidates.join("\n"));
  const { stdout } = await child;
  return new Set(stdout.split(/\r?\n/).filter(Boolean));
}
