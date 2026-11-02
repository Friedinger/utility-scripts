import { describe, expect, it } from "vitest";
import {
  hasWildcard,
  pathKey,
  splitPath,
  wildcardToRegExp,
} from "../src/lib/paths.ts";

describe("wildcardToRegExp", () => {
  it("matches * across separators", () => {
    const re = wildcardToRegExp(String.raw`D:\Archive\*`, true);
    expect(re.test(String.raw`D:\Archive\old\mise.toml`)).toBe(true);
    expect(re.test(String.raw`D:\Other\mise.toml`)).toBe(false);
  });

  it("matches ? as exactly one character", () => {
    const re = wildcardToRegExp("/p/a?c", false);
    expect(re.test("/p/abc")).toBe(true);
    expect(re.test("/p/ac")).toBe(false);
  });

  it("treats regex characters literally", () => {
    const re = wildcardToRegExp("/p/(x).toml", false);
    expect(re.test("/p/(x).toml")).toBe(true);
    expect(re.test("/p/(x)xtoml")).toBe(false);
  });

  it("follows the case setting", () => {
    expect(wildcardToRegExp("/P/*", true).test("/p/x")).toBe(true);
    expect(wildcardToRegExp("/P/*", false).test("/p/x")).toBe(false);
  });
});

describe("helpers", () => {
  it("detects wildcards", () => {
    expect(hasWildcard("/a/*")).toBe(true);
    expect(hasWildcard("/a/b")).toBe(false);
  });

  it("splits at both separators", () => {
    expect(splitPath(String.raw`C:\a/b\c`)).toEqual(["C:", "a", "b", "c"]);
    expect(splitPath("/home/me")).toEqual(["home", "me"]);
  });

  it("builds comparison keys", () => {
    expect(pathKey("/A", true)).toBe("/a");
    expect(pathKey("/A", false)).toBe("/A");
  });
});
