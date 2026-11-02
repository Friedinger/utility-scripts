/**
 * Whether paths on this platform compare case-insensitively. True for Windows
 * and macOS (default file systems), false for Linux.
 */
export const caseInsensitivePaths =
  process.platform === "win32" || process.platform === "darwin";

/** Key for comparing two paths the way the file system would. */
export function pathKey(
  p: string,
  caseInsensitive = caseInsensitivePaths,
): string {
  return caseInsensitive ? p.toLowerCase() : p;
}

/** Splits a path at both kinds of separators, without empty segments. */
export function splitPath(p: string): string[] {
  return p.split(/[\\/]/).filter(Boolean);
}

/**
 * Turns a wildcard pattern (`*` any run of characters, `?` one character) into
 * a regular expression for a whole path. `*` crosses separators, like
 * PowerShell's -like, so `D:\Archive\*` matches everything below the folder.
 */
export function wildcardToRegExp(
  pattern: string,
  caseInsensitive = caseInsensitivePaths,
): RegExp {
  const body = [...pattern]
    .map((ch) => {
      if (ch === "*") return ".*";
      if (ch === "?") return ".";
      return ch.replace(/[\\^$.|+()[\]{}]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${body}$`, caseInsensitive ? "i" : "");
}

export function hasWildcard(pattern: string): boolean {
  return /[*?]/.test(pattern);
}
