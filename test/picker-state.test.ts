import { describe, expect, it } from "vitest";
import {
  type KeyResult,
  type PickerConfig,
  PickerState,
  regionHeight,
  wrapKeys,
} from "../src/lib/picker/state.ts";

const paths = [
  "/p/a/one.toml",
  "/p/a/two.toml",
  "/p/b/c/three.toml",
  "/q/four.toml",
];

function picker(extra: Partial<PickerConfig> = {}): PickerState {
  return new PickerState({
    items: paths.map((text) => ({ text })),
    title: "Test",
    caseInsensitive: false,
    ...extra,
  });
}

const REGION = 10;
const press = (s: PickerState, ...keys: string[]): KeyResult[] =>
  keys.map((k) =>
    s.handleKey(k.length === 1 ? { char: k } : { name: k }, REGION),
  );

describe("PickerState list", () => {
  it("marks, toggles all and clears", () => {
    const s = picker();
    press(s, " ", "down", " ");
    expect(s.result()).toEqual([0, 1]);
    press(s, "a");
    expect(s.result()).toEqual([0, 1, 2, 3]);
    press(s, "a");
    expect(s.result()).toEqual([]);
    press(s, " ", "n");
    expect(s.result()).toEqual([]);
  });

  it("starts with items marked when asked", () => {
    const s = new PickerState({
      items: [{ text: "x", marked: true }, { text: "y" }],
      title: "",
    });
    expect(s.result()).toEqual([0]);
  });

  it("filters case-insensitively and marks only matches", () => {
    const s = picker();
    press(s, "/", "T", "W", "O", "return", "a");
    expect(s.visible()).toEqual([1]);
    expect(s.result()).toEqual([1]);
    press(s, "f", "backspace", "backspace", "backspace", "escape");
    expect(s.filter).toBe("");
    expect(s.visible()).toHaveLength(4);
  });

  it("marks flagged entries with d unless disabled", () => {
    const flags = [false, true, false, true];
    const s = picker({ flags });
    press(s, "d");
    expect(s.result()).toEqual([1, 3]);
    const quiet = picker({ flags, noFlagKey: true });
    press(quiet, "d");
    expect(quiet.result()).toEqual([]);
  });

  it("closes on Enter, Esc, q and Ctrl+C", () => {
    expect(picker().handleKey({ name: "return" }, REGION)).toBe("done");
    expect(picker().handleKey({ name: "escape" }, REGION)).toBe("cancel");
    expect(picker().handleKey({ char: "q" }, REGION)).toBe("cancel");
    expect(picker().handleKey({ name: "c", ctrl: true }, REGION)).toBe(
      "cancel",
    );
  });

  it("keeps the cursor inside the list", () => {
    const s = picker();
    press(s, "up");
    expect(s.cursor).toBe(0);
    press(s, "end", "down");
    expect(s.cursor).toBe(3);
    press(s, "pageup");
    expect(s.cursor).toBe(0);
    press(s, "pagedown");
    expect(s.cursor).toBe(3);
  });
});

describe("PickerState tree", () => {
  it("groups by folder and folds single-child chains", () => {
    const s = picker({ tree: true });
    press(s, "g");
    expect(s.rows().map((r) => `${r.depth}:${r.kind}:${r.text}`)).toEqual([
      "0:dir:p",
      "1:dir:a",
      "2:item:one.toml",
      "2:item:two.toml",
      "1:item:b/c/three.toml",
      "0:item:q/four.toml",
    ]);
  });

  it("marks everything below a folder and collapses it", () => {
    const s = picker({ tree: true });
    press(s, "g", "down", " ");
    expect(s.result()).toEqual([0, 1]);
    press(s, "left");
    expect(s.rows().map((r) => r.text)).toEqual([
      "p",
      "a",
      "b/c/three.toml",
      "q/four.toml",
    ]);
    press(s, "right");
    expect(s.rows()).toHaveLength(6);
    press(s, "down", "left");
    expect(s.cursor).toBe(1); // jumped back to the parent folder
  });

  it("keeps the same entry under the cursor when switching views", () => {
    const s = picker({ tree: true });
    press(s, "end", "g");
    s.settle(s.rows(), REGION);
    expect(s.rows()[s.cursor]?.index).toBe(3);
  });

  it("ignores g without tree support", () => {
    const s = picker();
    press(s, "g");
    expect(s.treeMode).toBe(false);
  });

  it("joins folders with backslashes for Windows paths", () => {
    const s = new PickerState({
      items: [String.raw`C:\x\a.toml`, String.raw`C:\x\b.toml`].map((text) => ({
        text,
      })),
      title: "",
      tree: true,
    });
    press(s, "g");
    expect(s.rows()[0]?.text).toBe(String.raw`C:\x`);
  });
});

describe("PickerState actions", () => {
  it("returns the action for the entry under the cursor", () => {
    const s = picker({ actions: [{ key: "v", label: "diff" }] });
    expect(press(s, "down", "v")).toEqual([
      undefined,
      { action: "v", index: 1 },
    ]);
    expect(press(s, "V")).toEqual([{ action: "v", index: 1 }]);
  });

  it("ignores actions on keys the list uses and on folders", () => {
    const s = picker({
      tree: true,
      startInTree: true,
      actions: [
        { key: "a", label: "taken" },
        { key: "v", label: "diff" },
      ],
    });
    expect(s.actions.map((a) => a.key)).toEqual(["v"]);
    expect(s.rows()[0]?.kind).toBe("dir");
    expect(press(s, "v")).toEqual([undefined]);
  });

  it("lists the actions in the help", () => {
    const s = picker({ actions: [{ key: "v", label: "full diff" }] });
    const help = s
      .view(REGION, 300, () => [])
      .slice(1, 3)
      .map((l) => l.text);
    expect(help.join(" ")).toContain("[v] full diff");
  });
});

describe("PickerState view", () => {
  it("draws title, help, rows, preview and status", () => {
    const s = picker({
      flags: [true, false, false, false],
      preview: true,
      flagLabel: "missing",
    });
    press(s, " ");
    const lines = s.view(REGION, 200, (i) => [`preview of ${i}`]);
    expect(lines).toHaveLength(REGION + 4);
    expect(lines[0]?.text).toBe("Test");
    expect(lines[1]?.text).toContain("[d] missing");
    expect(lines[3]).toMatchObject({
      text: "> [x] /p/a/one.toml",
      color: "red",
      highlight: true,
    });
    expect(lines.map((l) => l.text)).toContain("  preview of 0");
    expect(lines.at(-1)?.text).toBe(
      "1 marked · rows 1-4 of 4 · on row 1 · 1 missing (red)",
    );
  });

  it("shows the filter in the title", () => {
    const s = picker();
    press(s, "f", "x");
    expect(s.view(REGION, 200, () => [])[0]?.text).toBe("Test   filter: x▏");
  });
});

describe("layout helpers", () => {
  it("wraps help keys onto a second line", () => {
    expect(wrapKeys(["aaaa", "bbbb", "cccc"], 12)).toEqual([
      "aaaa · bbbb",
      "cccc",
    ]);
  });

  it("sizes the region to the items and the terminal", () => {
    expect(regionHeight(2, 40, false)).toBe(3);
    expect(regionHeight(100, 40, false)).toBe(34);
    expect(regionHeight(2, 40, true)).toBe(9);
  });
});
