import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type Commit,
  checkRepo,
  inspect,
  isForeign,
  makePlan,
  moveBranch,
  readIdentity,
  resolveBase,
  rewrite,
} from "../src/git-adopt/adopt.ts";
import { tempDir } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/git-adopt/cli.ts", import.meta.url));

const ME = { name: "Me", email: "me@example.com" };
const CLAUDE = { name: "Claude", email: "noreply@anthropic.com" };
const OTHER = { name: "Other", email: "other@example.com" };

// One pair of SSH keys for all tests: mine and a "foreign" one, like the key
// the cloud environment signs with.
const keys = mkdtempSync(join(tmpdir(), "git-adopt-keys-"));
const keygen = (name: string): string => {
  const file = join(keys, name);
  const r = spawnSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    name,
    "-f",
    file,
  ]);
  return r.status === 0 ? file : "";
};
const myKey = keygen("me");
const claudeKey = keygen("claude");
const canSign = Boolean(myKey && claudeKey);
const allowedSigners = join(keys, "allowed_signers");
if (canSign)
  writeFileSync(
    allowedSigners,
    [
      `${ME.email} namespaces="git" ${readFileSync(myKey + ".pub", "utf8").trim()}`,
      `${CLAUDE.email} namespaces="git" ${readFileSync(claudeKey + ".pub", "utf8").trim()}`,
    ].join("\n") + "\n",
  );

afterAll(() => rmSync(keys, { recursive: true, force: true, maxRetries: 5 }));

let dir: string;
let remote: string;
let work: string;

/** Runs git with the test's environment and returns trimmed stdout. */
const g = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trimEnd();

let fileNo = 0;
/** Commits a new file as `who`, signed with `key`. */
function commit(
  cwd: string,
  who: { name: string; email: string },
  key: string,
  ...messages: string[]
): string {
  writeFileSync(join(cwd, `f${++fileNo}.txt`), `${fileNo}\n`);
  g(cwd, "add", "-A");
  g(
    cwd,
    "-c",
    `user.name=${who.name}`,
    "-c",
    `user.email=${who.email}`,
    "-c",
    `user.signingkey=${key}`,
    "commit",
    "-q",
    "-S",
    ...messages.flatMap((m) => ["-m", m]),
  );
  return g(cwd, "rev-parse", "HEAD");
}
const mine = (...m: string[]): string => commit(work, ME, myKey, ...m);
const claude = (...m: string[]): string =>
  commit(work, CLAUDE, claudeKey, ...m);

const field = (rev: string, format: string): string =>
  g(work, "log", "-1", `--format=${format}`, rev);
const rawMessage = (rev: string): string => {
  const raw = execFileSync("git", ["cat-file", "commit", rev], {
    cwd: work,
    encoding: "utf8",
  });
  return raw.slice(raw.indexOf("\n\n") + 2);
};
const hashes = (range = "main..feature"): string[] =>
  g(work, "rev-list", "--topo-order", "--reverse", range)
    .split("\n")
    .filter(Boolean);

async function run(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { cwd: work, env: { ...process.env, NO_COLOR: "1" }, encoding: "utf8" },
      (error, stdout, stderr) =>
        resolve({
          code: error ? Number(error.code ?? 1) : 0,
          out: stdout + stderr,
        }),
    );
  });
}

beforeEach(async () => {
  dir = await tempDir();
  const config = join(dir, "gitconfig");
  writeFileSync(
    config,
    [
      "[user]",
      `  name = ${ME.name}`,
      `  email = ${ME.email}`,
      `  signingkey = ${myKey.replaceAll("\\", "/")}`,
      "[gpg]",
      "  format = ssh",
      '[gpg "ssh"]',
      `  allowedSignersFile = ${allowedSigners.replaceAll("\\", "/")}`,
      "[init]",
      "  defaultBranch = main",
      "[core]",
      "  autocrlf = false",
      "",
    ].join("\n"),
  );
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const k of Object.keys(process.env))
    if (/^GIT_(AUTHOR|COMMITTER)_/.test(k)) vi.stubEnv(k, undefined);

  remote = join(dir, "remote.git");
  work = join(dir, "work");
  g(dir, "init", "-q", "--bare", "-b", "main", remote);
  g(dir, "clone", "-q", remote, work);
  if (canSign) mine("init");
  else {
    writeFileSync(join(work, "f0.txt"), "0\n");
    g(work, "add", "-A");
    g(work, "commit", "-q", "-m", "init");
  }
  g(work, "push", "-q", "origin", "main");
  g(work, "switch", "-q", "-c", "feature");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Adopts the pre-marked commits through the API, like `git-adopt --yes`. */
function adoptAll(author?: string): { before: string[]; after: string[] } {
  const info = inspect(work);
  const me = readIdentity(work);
  const marked = info.commits.filter((c) => isForeign(c, me, author));
  const plan = makePlan(info.commits, new Set(marked.map((c) => c.hash)));
  const head = rewrite(work, plan, me);
  moveBranch(work, info.branch, info.head, head);
  return { before: info.commits.map((c) => c.hash), after: hashes() };
}

describe("makePlan", () => {
  const c = (hash: string, ...parents: string[]): Commit => ({
    hash,
    parents,
    authorName: "",
    authorEmail: "",
    committerName: "",
    committerEmail: "",
    subject: "",
  });

  it("keeps everything before the first marked commit and re-signs what follows", () => {
    const plan = makePlan(
      [c("a", "base"), c("b", "a"), c("c", "b"), c("d", "c")],
      new Set(["b"]),
    );
    expect(plan.map((e) => e.step)).toEqual([
      "keep",
      "adopt",
      "resign",
      "resign",
    ]);
  });

  it("keeps side branches that do not descend from a rewritten commit", () => {
    const plan = makePlan(
      [c("a", "base"), c("x", "base"), c("b", "a"), c("m", "b", "x")],
      new Set(["a"]),
    );
    expect(plan.map((e) => e.step)).toEqual([
      "adopt",
      "keep",
      "resign",
      "resign",
    ]);
  });
});

describe("isForeign", () => {
  const commit = (author: string, committer: string): Commit => ({
    hash: "",
    parents: [],
    authorName: "",
    authorEmail: author,
    committerName: "",
    committerEmail: committer,
    subject: "",
  });

  it("marks commits by someone else or committed by someone else", () => {
    expect(isForeign(commit(ME.email, ME.email), ME)).toBe(false);
    expect(isForeign(commit("ME@Example.com", ME.email), ME)).toBe(false);
    expect(isForeign(commit(CLAUDE.email, CLAUDE.email), ME)).toBe(true);
    expect(isForeign(commit(ME.email, CLAUDE.email), ME)).toBe(true);
  });

  it("only marks the given author with --author", () => {
    expect(
      isForeign(commit(CLAUDE.email, CLAUDE.email), ME, CLAUDE.email),
    ).toBe(true);
    expect(isForeign(commit(OTHER.email, OTHER.email), ME, CLAUDE.email)).toBe(
      false,
    );
    expect(isForeign(commit(ME.email, CLAUDE.email), ME, ME.email)).toBe(false);
  });
});

describe.skipIf(!canSign)("rewriting", () => {
  it("adopts foreign commits, keeps earlier ones and re-signs later ones", () => {
    const m1 = mine("✨ Mine first");
    claude(
      "✨ Add parser",
      "Body line one\nline two",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
    );
    claude("✅ Add tests");
    mine("♻️ Mine last");
    const before = hashes();
    const oldHead = before.at(-1)!;

    const { after } = adoptAll();

    expect(after).toHaveLength(4);
    expect(after[0]).toBe(m1);
    for (let i = 1; i < 4; i++) expect(after[i]).not.toBe(before[i]);
    for (let i = 0; i < 4; i++) {
      expect(g(work, "rev-parse", `${after[i]}^{tree}`)).toBe(
        g(work, "rev-parse", `${before[i]}^{tree}`),
      );
      expect(rawMessage(after[i]!)).toBe(rawMessage(before[i]!));
      expect(field(after[i]!, "%at")).toBe(field(before[i]!, "%at"));
      expect(field(after[i]!, "%an <%ae> / %cn <%ce>")).toBe(
        "Me <me@example.com> / Me <me@example.com>",
      );
    }
    for (const h of after.slice(1)) {
      expect(field(h, "%G?")).toBe("G");
      expect(field(h, "%GS")).toBe(ME.email);
    }
    // Working tree untouched, old state kept in the backup ref.
    expect(g(work, "status", "--porcelain")).toBe("");
    expect(g(work, "rev-parse", "refs/adopt/backup/feature")).toBe(oldHead);
  });

  it("changes nothing on a second run", () => {
    claude("one");
    adoptAll();
    const info = inspect(work);
    const me = readIdentity(work);
    expect(info.commits.filter((c) => isForeign(c, me))).toEqual([]);
    expect(
      makePlan(info.commits, new Set()).every((e) => e.step === "keep"),
    ).toBe(true);
  });

  it("keeps merge commits as merges", () => {
    claude("on feature");
    g(work, "switch", "-q", "main");
    const onMain = mine("on main");
    g(work, "push", "-q", "origin", "main");
    g(work, "switch", "-q", "feature");
    g(
      work,
      "-c",
      `user.name=${CLAUDE.name}`,
      "-c",
      `user.email=${CLAUDE.email}`,
      "-c",
      `user.signingkey=${claudeKey}`,
      "merge",
      "-q",
      "--no-ff",
      "-S",
      "-m",
      "Merge main",
      "origin/main",
    );
    claude("after merge");

    adoptAll();

    const merge = g(work, "rev-parse", "HEAD~1");
    const parents = field(merge, "%P").split(" ");
    expect(parents).toHaveLength(2);
    expect(parents[1]).toBe(onMain);
    expect(field(merge, "%ae %G?")).toBe(`${ME.email} G`);
    expect(g(work, "status", "--porcelain")).toBe("");
  });

  it("only pre-marks the given author with --author", () => {
    claude("by claude");
    commit(work, OTHER, claudeKey, "by other");
    const { before, after } = adoptAll(CLAUDE.email);
    expect(after).not.toEqual(before);
    expect(field(after[0]!, "%ae")).toBe(ME.email);
    // Re-signed, not adopted: the author stays.
    expect(field(after[1]!, "%ae %ce")).toBe(`${OTHER.email} ${ME.email}`);
  });
});

describe.skipIf(!canSign)("cli", () => {
  it("adopts and pushes with --yes --push", async () => {
    claude("from claude");
    g(work, "push", "-q", "-u", "origin", "feature");

    const r = await run("--yes", "--push");
    expect(r.out).toContain("pushed");
    expect(r.code).toBe(0);
    expect(g(remote, "rev-parse", "feature")).toBe(
      g(work, "rev-parse", "HEAD"),
    );
    expect(field("HEAD", "%ae %G?")).toBe(`${ME.email} G`);

    const again = await run("--yes", "--push");
    expect(again.code).toBe(0);
    expect(again.out).toContain("Nothing to adopt");
  });

  it("does not overwrite commits pushed in the meantime", async () => {
    claude("from claude");
    g(work, "push", "-q", "-u", "origin", "feature");
    const other = join(dir, "other");
    g(dir, "clone", "-q", "-b", "feature", remote, other);
    commit(other, CLAUDE, claudeKey, "pushed meanwhile");
    g(other, "push", "-q", "origin", "feature");
    const remoteHead = g(remote, "rev-parse", "feature");

    // Without fetching, the lease is the old state: the push must fail.
    const r = await run("--yes", "--push", "--no-fetch");
    expect(r.code).toBe(1);
    expect(g(remote, "rev-parse", "feature")).toBe(remoteHead);

    // With fetching, git-adopt sees the missing commit and stops before rewriting.
    g(work, "reset", "-q", "--keep", "refs/adopt/backup/feature");
    const head = g(work, "rev-parse", "HEAD");
    const r2 = await run("--yes", "--push");
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("pull first");
    expect(g(work, "rev-parse", "HEAD")).toBe(head);
  });

  it("changes nothing with --dry-run", async () => {
    claude("from claude");
    const head = g(work, "rev-parse", "HEAD");
    const r = await run("--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/adopt\s+\w{7}\s+from claude/);
    expect(r.out).toContain("Dry run");
    expect(g(work, "rev-parse", "HEAD")).toBe(head);
  });

  it("stops before rewriting when signing does not work", async () => {
    claude("from claude");
    g(work, "config", "user.signingkey", join(dir, "missing-key"));
    const head = g(work, "rev-parse", "HEAD");
    const r = await run("--yes");
    expect(r.code).toBe(1);
    expect(r.out).toContain("Signing does not work");
    expect(g(work, "rev-parse", "HEAD")).toBe(head);
  });

  it("needs --yes without a terminal", async () => {
    claude("from claude");
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("--yes");
  });
});

describe("checks", () => {
  it("finds master as the base when there is no main", async () => {
    const solo = join(await tempDir(), "solo");
    mkdirSync(solo);
    g(solo, "init", "-q", "-b", "master");
    g(solo, "commit", "-q", "--allow-empty", "-m", "init");
    expect(resolveBase(solo)).toBe("master");
    expect(() => resolveBase(solo, "nope")).toThrow(/not found/);
  });

  it("uses origin's default branch", () => {
    expect(resolveBase(work)).toBe("origin/main");
  });

  it("refuses a detached HEAD", () => {
    g(work, "switch", "-q", "--detach");
    expect(() => checkRepo(work)).toThrow(/detached/);
  });

  it("refuses while a rebase is in progress", () => {
    mkdirSync(join(work, ".git", "rebase-merge"));
    expect(() => checkRepo(work)).toThrow(/rebase is in progress/);
  });

  it("needs a configured identity", () => {
    writeFileSync(process.env.GIT_CONFIG_GLOBAL!, "");
    expect(() => readIdentity(work)).toThrow(/user\.name/);
  });
});
