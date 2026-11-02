import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];

/** A fresh temp folder, removed after the test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "utility-scripts-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/** Writes a tracked-configs entry the way mise does on this platform. */
export async function track(
  stateDir: string,
  name: string,
  target: string,
): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  const entry = join(stateDir, name);
  if (process.platform === "win32") await writeFile(entry, target);
  else await symlink(target, entry);
  return entry;
}

/** Creates a config file, including its folders. */
export async function config(
  path: string,
  content = "[tools]\n",
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}
