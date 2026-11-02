import { execFile } from "node:child_process";
import { lstat, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  forget,
  isMissing,
  matchPatterns,
  preview,
  readTracked,
} from "../src/mise-forget/tracked.ts";
import { config, tempDir, track } from "./helpers.ts";

const cli = fileURLToPath(
  new URL("../src/mise-forget/cli.ts", import.meta.url),
);

/** A state folder with one live and one missing config. */
async function setup() {
  const root = await tempDir();
  const state = join(root, "tracked-configs");
  const live = await config(join(root, "projects", "live", "mise.toml"));
  const gone = join(root, "projects", "gone", "mise.toml");
  await track(state, "a1", live);
  await track(state, "b2", gone);
  return { root, state, live, gone };
}

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [cli, ...args],
      {
        env: { ...process.env, NO_COLOR: "1" },
      },
    );
    return { code: 0, out: stdout };
  } catch (error) {
    const e = error as { code: number; stdout: string };
    return { code: e.code, out: e.stdout };
  }
}

describe("readTracked", () => {
  it("reads the entries mise writes on this platform", async () => {
    const { state, live, gone } = await setup();
    const tracked = await readTracked(state);
    expect(tracked.map((t) => t.path).sort()).toEqual([gone, live].sort());
    expect(tracked.every((t) => t.entries.length === 1)).toBe(true);
  });

  it("groups several entries for the same path", async () => {
    const { state, live } = await setup();
    await track(state, "c3", live);
    const entry = (await readTracked(state)).find((t) => t.path === live);
    expect(entry?.entries).toHaveLength(2);
  });

  it("reads plain files as entries only on Windows", async () => {
    const state = await tempDir();
    await writeFile(join(state, "x"), "  C:\\p\\mise.toml\n");
    expect(await readTracked(state, "win32")).toEqual([
      { path: "C:\\p\\mise.toml", entries: [join(state, "x")] },
    ]);
    if (process.platform !== "win32")
      expect(await readTracked(state, "linux")).toEqual([]);
  });
});

describe("isMissing and preview", () => {
  it("reports missing configs and folders", async () => {
    const { root, live, gone } = await setup();
    expect(isMissing(live)).toBe(false);
    expect(isMissing(gone)).toBe(true);
    expect(isMissing(root)).toBe(true); // a folder is not a config
    expect(preview(gone)).toEqual(["(file not found)", "(folder gone too)"]);
  });

  it("shows date and first lines", async () => {
    const root = await tempDir();
    const file = await config(join(root, "mise.toml"), "a\r\nb\nc\nd\ne\n");
    const lines = preview(file);
    expect(lines[0]).toMatch(/^modified \d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(lines.slice(1)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("matchPatterns", () => {
  const tracked = ["/p/a/mise.toml", "/p/b/mise.toml", "/q/mise.toml"];

  it("matches exact paths and wildcards", () => {
    expect(matchPatterns(tracked, ["/q/mise.toml", "/p/*"], false)).toEqual({
      matched: tracked,
      unmatched: [],
    });
  });

  it("reports patterns without a match", () => {
    expect(matchPatterns(tracked, ["/x/*", " /p/a/mise.toml "], false)).toEqual(
      {
        matched: ["/p/a/mise.toml"],
        unmatched: ["/x/*"],
      },
    );
  });

  it("follows the case setting", () => {
    expect(matchPatterns(tracked, ["/Q/MISE.toml"], true).matched).toEqual([
      "/q/mise.toml",
    ]);
    expect(matchPatterns(tracked, ["/Q/MISE.toml"], false).matched).toEqual([]);
  });
});

describe("forget", () => {
  it("deletes the entry but never the config", async () => {
    const { state, live } = await setup();
    const [entry] = (await readTracked(state)).filter((t) => t.path === live);
    await forget(entry!, "permanent");
    expect(await readdir(state)).toEqual(["b2"]);
    expect(isMissing(live)).toBe(false);
  });

  it("succeeds when the entry is already gone", async () => {
    const { state, gone } = await setup();
    const [entry] = (await readTracked(state)).filter((t) => t.path === gone);
    await rm(entry!.entries[0]!);
    await expect(forget(entry!, "permanent")).resolves.toBeUndefined();
  });
});

describe("mise-forget cli", () => {
  it("previews with --dry-run and changes nothing", async () => {
    const { state, gone } = await setup();
    const { code, out } = await run(
      "--state-dir",
      state,
      "--missing",
      "--dry-run",
    );
    expect(code).toBe(0);
    expect(out).toContain(`Would move to the trash: ${gone}`);
    expect(await readdir(state)).toHaveLength(2);
  });

  it("removes matches with --yes --permanent", async () => {
    const { state, root, live } = await setup();
    const { code, out } = await run(
      "--state-dir",
      state,
      join(root, "projects", "*"),
      "-y",
      "--permanent",
    );
    expect(code).toBe(0);
    expect(out).toContain("Removed: 2, failed: 0");
    expect(await readdir(state)).toEqual([]);
    expect((await lstat(live)).isFile()).toBe(true);
  });

  it("combines paths with --missing", async () => {
    const { state, root } = await setup();
    const { out } = await run(
      "--state-dir",
      state,
      join(root, "projects", "*"),
      "-m",
      "-n",
    );
    expect(out).toContain("About to remove 1 entry:");
  });

  it("fails for unknown paths", async () => {
    const { state } = await setup();
    const { code, out } = await run(
      "--state-dir",
      state,
      "/nowhere/mise.toml",
      "-y",
    );
    expect(code).toBe(1);
    expect(out).toContain("Not in the list: /nowhere/mise.toml");
    expect(out).toContain("Nothing to remove.");
  });

  it("refuses --yes without a path or --missing", async () => {
    const { state } = await setup();
    const { code, out } = await run("--state-dir", state, "-y");
    expect(code).toBe(1);
    expect(out).toContain("--yes needs a path or --missing.");
  });

  it("needs a terminal for the list and for confirming", async () => {
    const { state } = await setup();
    expect((await run("--state-dir", state)).out).toContain(
      "needs an interactive terminal",
    );
    expect((await run("--state-dir", state, "-m")).out).toContain("pass --yes");
  });

  it("reports a missing state folder", async () => {
    const root = await tempDir();
    const { code, out } = await run("--state-dir", join(root, "nope"), "-m");
    expect(code).toBe(1);
    expect(out).toContain("Folder not found");
  });

  it("prints help", async () => {
    const { code, out } = await run("--help");
    expect(code).toBe(0);
    expect(out).toContain("Usage: mise-forget");
  });
});
