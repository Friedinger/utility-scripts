/**
 * Small multi-select list for the terminal. Draws {@link PickerState} into a
 * fixed region below the cursor and feeds it the keys.
 *
 * Keys: ↑↓ PgUp PgDn Home End move · Space mark · a all matching · n none ·
 * d all flagged · g list/tree · ←→ fold · p preview · f or / filter ·
 * Enter done · Esc, q or Ctrl+C cancel, plus the caller's action keys.
 */
import { emitKeypressEvents } from "node:readline";
import { ask, paint } from "../term.ts";
import {
  type Key,
  type KeyResult,
  type Line,
  type PickerItem,
  PickerState,
  regionHeight,
} from "./state.ts";

export type { PickerItem } from "./state.ts";

export interface PickAction<T> {
  label: string;
  /**
   * Runs for the entry under the cursor, in the normal terminal (so it can
   * open a pager); the list is drawn again afterwards.
   */
  run: (item: T) => void | Promise<void>;
}

export interface PickOptions<T> {
  items: T[];
  title: string;
  /** How an item is shown; strings are shown as they are. */
  describe?: (item: T) => PickerItem;
  /** Items to show in red. */
  flag?: (item: T) => boolean;
  flagLabel?: string;
  noFlagKey?: boolean;
  /** Allow switching to a folder tree with `g`. */
  tree?: boolean;
  /** Start in the folder tree (needs `tree`). */
  startInTree?: boolean;
  /** Up to five lines about the item under the cursor. Cached per item. */
  preview?: (item: T) => string[];
  /** Extra single-letter keys; keys the list uses itself are ignored. */
  actions?: Record<string, PickAction<T>>;
}

export interface PickResult<T> {
  cancelled: boolean;
  /** Marked items, in their original order. */
  items: T[];
}

const ESC = "\x1b[";

export async function pick<T>(options: PickOptions<T>): Promise<PickResult<T>> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY)
    throw new Error("The list needs an interactive terminal.");

  const describe = options.describe ?? ((item: T) => ({ text: String(item) }));
  const actions = options.actions ?? {};
  const state = new PickerState({
    items: options.items.map(describe),
    title: options.title,
    flags: options.flag ? options.items.map(options.flag) : [],
    ...(options.flagLabel !== undefined && { flagLabel: options.flagLabel }),
    noFlagKey: Boolean(options.noFlagKey),
    tree: Boolean(options.tree),
    startInTree: Boolean(options.startInTree),
    preview: Boolean(options.preview),
    actions: Object.entries(actions).map(([key, a]) => ({
      key,
      label: a.label,
    })),
  });

  const previewCache = new Map<number, string[]>();
  const preview = (index: number): string[] => {
    let lines = previewCache.get(index);
    if (!lines) {
      try {
        lines = options.preview?.(options.items[index]!) ?? [];
      } catch {
        lines = ["(preview failed)"];
      }
      previewCache.set(index, lines);
    }
    return lines;
  };

  const region = regionHeight(
    options.items.length,
    stdout.rows,
    Boolean(options.preview),
  );
  const total = region + 4;

  const draw = (): void => {
    const width = Math.max(20, stdout.columns - 1);
    const lines = state.view(region, width, preview);
    // Back to the top of the region, then rewrite every line of it.
    stdout.write(
      `${ESC}${total}F` + lines.map((l) => render(l, width) + "\n").join(""),
    );
  };

  // enter() reserves the region (the cursor stays on the line below it
  // between draws) and takes over the keyboard; leave() hands both back.
  emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  const enter = (): void => {
    stdout.write("\n".repeat(total) + `${ESC}?25l`);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.on("resize", draw);
    draw();
  };
  const leave = (): void => {
    stdout.off("resize", draw);
    stdin.setRawMode(wasRaw);
    stdin.pause();
    stdout.write(`${ESC}?25h`);
  };

  const nextResult = (): Promise<KeyResult> =>
    new Promise((resolve) => {
      const onKey = (
        char: string | undefined,
        key: KeypressKey | undefined,
      ): void => {
        const result = state.handleKey(toKey(char, key), region);
        if (result) {
          stdin.off("keypress", onKey);
          resolve(result);
        } else {
          draw();
        }
      };
      stdin.on("keypress", onKey);
    });

  enter();
  try {
    for (;;) {
      const result = await nextResult();
      if (result === "done" || result === "cancel") {
        return {
          cancelled: result === "cancel",
          items:
            result === "cancel"
              ? []
              : state.result().map((i) => options.items[i]!),
        };
      }
      if (!result) continue;
      leave();
      try {
        await actions[result.action]!.run(options.items[result.index]!);
      } catch (error) {
        stdout.write(
          paint("red", `Action failed: ${(error as Error).message}`) + "\n",
        );
        await ask(paint("gray", "Press Enter to go back to the list..."));
      }
      enter();
    }
  } finally {
    leave();
  }
}

interface KeypressKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
}

function toKey(char: string | undefined, key: KeypressKey | undefined): Key {
  const out: Key = {};
  // Space comes as name "space"; let it through as a character like any other.
  if (key?.name && key.name !== "space" && (key.name.length > 1 || key.ctrl))
    out.name = key.name;
  if (key?.name === "enter") out.name = "return";
  if (char && !out.name) out.char = char;
  if (key?.ctrl) out.ctrl = true;
  return out;
}

function render(line: Line, width: number): string {
  let text = line.text;
  if (text.length > width) text = text.slice(0, width - 1) + "…";
  text = text.padEnd(width);
  let out = paint(line.color, text);
  if (line.highlight) out = paint("inverse", out);
  return `${ESC}2K` + out;
}
