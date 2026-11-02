/**
 * State and key handling of the multi-select list, without any terminal I/O,
 * so all of it can be tested directly. `picker/index.ts` draws it.
 */
import type { Color } from "../term.ts";
import { pathKey, splitPath } from "../paths.ts";

/** How one entry is shown. */
export interface PickerItem {
  /** The line shown in the list, also what the filter matches. */
  text: string;
  /** Name shown in the tree instead of the last part of `text`. */
  label?: string;
  /** Folders of the entry in the tree; without it `text` is split at \ and /. */
  path?: string[];
  /** Start with the entry marked. */
  marked?: boolean;
}

export interface PickerConfig {
  items: PickerItem[];
  title: string;
  /** Entries to highlight in red, e.g. files that no longer exist. */
  flags?: boolean[];
  flagLabel?: string;
  /** Only color flagged entries, without the `d` key that marks them. */
  noFlagKey?: boolean;
  /** Allow `g` to switch to a folder tree. */
  tree?: boolean;
  /** Whether there is a preview (toggled with `p`, on by default). */
  preview?: boolean;
  /** Start in the folder tree instead of the flat list (needs `tree`). */
  startInTree?: boolean;
  /** Extra keys that run something for the entry under the cursor. */
  actions?: { key: string; label: string }[];
  /** Fold folder names that only differ in case. Defaults to the platform. */
  caseInsensitive?: boolean;
}

/** What a key press asks the list to do. */
export type KeyResult =
  "done" | "cancel" | { action: string; index: number } | undefined;

/** Keys the list uses itself; actions on them are ignored. */
const RESERVED_KEYS = new Set([" ", "a", "n", "d", "g", "p", "f", "/", "q"]);

export interface Row {
  kind: "item" | "dir";
  /** Item index, -1 for folders. */
  index: number;
  text: string;
  depth: number;
  /** Folder id, for collapsing. */
  id: string;
  /** Item indices below this row (just the item itself for entries). */
  leaves: number[];
  open: boolean;
  /** Row index of the parent folder, -1 at the top. */
  parent: number;
}

export interface Key {
  /** Named key: up, down, pageup, pagedown, home, end, left, right, return, escape, backspace. */
  name?: string;
  /** Printable character typed. */
  char?: string;
  ctrl?: boolean;
}

export interface Line {
  text: string;
  color?: Color;
  highlight?: boolean;
}

export const PREVIEW_ROWS = 6;

export class PickerState {
  readonly texts: string[];
  readonly labels: (string | undefined)[];
  readonly paths: (string[] | undefined)[];
  readonly flags: boolean[];
  readonly flagCount: number;
  readonly title: string;
  readonly flagLabel: string;
  readonly noFlagKey: boolean;
  readonly treeAllowed: boolean;
  readonly hasPreview: boolean;
  readonly caseInsensitive: boolean | undefined;
  readonly actions: { key: string; label: string }[];
  /** Separator used when folder names are joined for display. */
  readonly sep: string;

  selected = new Set<number>();
  treeMode = false;
  collapsed = new Set<string>();
  filter = "";
  filtering = false;
  cursor = 0;
  offset = 0;
  previewOn: boolean;
  /** Item to put the cursor on after the next layout (list <-> tree switch). */
  pendingIndex = -1;

  constructor(config: PickerConfig) {
    this.texts = config.items.map((i) => i.text);
    this.labels = config.items.map((i) => i.label);
    this.paths = config.items.map((i) => i.path);
    config.items.forEach((item, i) => {
      if (item.marked) this.selected.add(i);
    });
    this.flags = config.items.map((_, i) => Boolean(config.flags?.[i]));
    this.flagCount = this.flags.filter(Boolean).length;
    this.title = config.title;
    this.flagLabel = config.flagLabel ?? "flagged";
    this.noFlagKey = Boolean(config.noFlagKey);
    this.treeAllowed = Boolean(config.tree);
    this.hasPreview = Boolean(config.preview);
    this.previewOn = this.hasPreview;
    this.caseInsensitive = config.caseInsensitive;
    this.treeMode = this.treeAllowed && Boolean(config.startInTree);
    this.actions = (config.actions ?? []).filter(
      (a) => a.key.length === 1 && !RESERVED_KEYS.has(a.key.toLowerCase()),
    );
    this.sep = this.texts.some((t) => t.includes("\\")) ? "\\" : "/";
  }

  /** Item indices matching the filter. */
  visible(): number[] {
    const needle = this.filter.toLowerCase();
    const all = this.texts.map((_, i) => i);
    return needle
      ? all.filter((i) => this.texts[i]!.toLowerCase().includes(needle))
      : all;
  }

  /** The rows to draw: one per visible item, or a folder tree of them. */
  rows(visible = this.visible()): Row[] {
    if (!this.treeMode) {
      return visible.map((i) => ({
        kind: "item",
        index: i,
        text: this.texts[i]!,
        depth: 0,
        id: "",
        leaves: [i],
        open: false,
        parent: -1,
      }));
    }
    const root = newNode("", "");
    for (const idx of visible) {
      let segs: string[];
      const explicit = this.paths[idx];
      if (explicit) {
        // Explicit folders (so names like feature/x are not split); the label is the entry.
        segs = [...explicit, this.labels[idx] ?? this.texts[idx]!];
      } else {
        segs = splitPath(this.texts[idx]!);
        if (segs.length === 0) segs = [this.texts[idx]!];
      }
      let node = root;
      node.all.push(idx);
      for (const seg of segs.slice(0, -1)) {
        const key = pathKey(seg, this.caseInsensitive);
        let child = node.dirs.get(key);
        if (!child) {
          child = newNode(seg, `${node.id}/${key}`);
          node.dirs.set(key, child);
        }
        node = child;
        node.all.push(idx);
      }
      node.files.push({ index: idx, label: segs.at(-1)! });
    }
    const out: Row[] = [];
    this.addTreeRows(root, 0, -1, out);
    return out;
  }

  // Folders first (chains of single-child folders are shown as one row), then
  // the entries. Collapsed folders hide their children.
  private addTreeRows(
    node: TreeNode,
    depth: number,
    parent: number,
    out: Row[],
  ): void {
    for (const start of [...node.dirs.values()].sort((a, b) =>
      compare(a.name, b.name),
    )) {
      let d = start;
      let label = d.name;
      while (d.dirs.size === 1 && d.files.length === 0) {
        d = [...d.dirs.values()][0]!;
        label += this.sep + d.name;
      }
      if (d.dirs.size === 0 && d.files.length === 1) {
        // A folder with a single entry is shown as that entry, no extra level.
        const f = d.files[0]!;
        out.push({
          kind: "item",
          index: f.index,
          text: `${label}${this.sep}${f.label}`,
          depth,
          id: "",
          leaves: [f.index],
          open: false,
          parent,
        });
        continue;
      }
      const open = !this.collapsed.has(d.id);
      out.push({
        kind: "dir",
        index: -1,
        text: label,
        depth,
        id: d.id,
        leaves: d.all,
        open,
        parent,
      });
      if (open) this.addTreeRows(d, depth + 1, out.length - 1, out);
    }
    for (const f of [...node.files].sort((a, b) => compare(a.label, b.label))) {
      out.push({
        kind: "item",
        index: f.index,
        text: f.label,
        depth,
        id: "",
        leaves: [f.index],
        open: false,
        parent,
      });
    }
  }

  /** Rows available for the list itself, given the height of the list region. */
  listRows(region: number): number {
    return this.previewOn ? region - PREVIEW_ROWS : region;
  }

  /** Brings cursor and scroll offset in line with the rows; call before drawing. */
  settle(rows: Row[], region: number): void {
    if (this.pendingIndex >= 0) {
      const at = rows.findIndex(
        (r) => r.kind === "item" && r.index === this.pendingIndex,
      );
      if (at >= 0) this.cursor = at;
      this.pendingIndex = -1;
    }
    const listRows = this.listRows(region);
    if (this.cursor >= rows.length) this.cursor = Math.max(0, rows.length - 1);
    if (this.cursor < this.offset) this.offset = this.cursor;
    if (this.cursor >= this.offset + listRows)
      this.offset = this.cursor - listRows + 1;
  }

  /**
   * Applies one key. Returns "done" or "cancel" when the list should close,
   * an action for an action key on an entry, otherwise undefined.
   */
  handleKey(key: Key, region: number): KeyResult {
    if (key.ctrl && key.name === "c") return "cancel";
    const visible = this.visible();
    const rows = this.rows(visible);
    const last = Math.max(0, rows.length - 1);
    const listRows = this.listRows(region);
    const row = rows[this.cursor];

    switch (key.name) {
      case "up":
        if (this.cursor > 0) this.cursor--;
        return;
      case "down":
        if (this.cursor < last) this.cursor++;
        return;
      case "pageup":
        this.cursor = Math.max(0, this.cursor - listRows);
        return;
      case "pagedown":
        this.cursor = Math.min(last, this.cursor + listRows);
        return;
      case "home":
        this.cursor = 0;
        return;
      case "end":
        this.cursor = last;
        return;
      case "left":
        // Collapse the folder, or jump to the parent folder.
        if (this.treeMode && row) {
          if (row.kind === "dir" && row.open) this.collapsed.add(row.id);
          else if (row.parent >= 0) this.cursor = row.parent;
        }
        return;
      case "right":
        // Expand the folder, or step into it.
        if (this.treeMode && row?.kind === "dir") {
          if (!row.open) this.collapsed.delete(row.id);
          else if (this.cursor < last) this.cursor++;
        }
        return;
      case "return":
        if (this.filtering) this.filtering = false;
        else return "done";
        return;
      case "escape":
        if (this.filtering) this.filtering = false;
        else return "cancel";
        return;
    }

    if (this.filtering) {
      if (key.name === "backspace") {
        if (this.filter) this.setFilter(this.filter.slice(0, -1));
      } else if (key.char && !key.ctrl && !/\p{Cc}/u.test(key.char)) {
        this.setFilter(this.filter + key.char);
      }
      return;
    }

    switch (key.char) {
      case " ":
        // An entry toggles itself, a folder toggles everything below it.
        if (row) this.toggle(row.leaves);
        return;
      case "a":
        if (visible.length) this.toggle(visible);
        return;
      case "n":
        this.selected.clear();
        return;
      case "d":
        if (!this.noFlagKey)
          for (const v of visible) if (this.flags[v]) this.selected.add(v);
        return;
      case "g":
        if (this.treeAllowed) {
          this.pendingIndex = row?.kind === "item" ? row.index : -1;
          this.treeMode = !this.treeMode;
          this.cursor = 0;
          this.offset = 0;
        }
        return;
      case "p":
        if (this.hasPreview) this.previewOn = !this.previewOn;
        return;
      case "f":
      case "/":
        this.filtering = true;
        return;
      case "q":
        return "cancel";
    }
    const action = key.char?.toLowerCase();
    if (row?.kind === "item" && this.actions.some((a) => a.key === action)) {
      return { action: action!, index: row.index };
    }
    return;
  }

  /** Marks all of `indices`, or unmarks them if they all are marked already. */
  private toggle(indices: number[]): void {
    const allOn = indices.every((i) => this.selected.has(i));
    for (const i of indices) {
      if (allOn) this.selected.delete(i);
      else this.selected.add(i);
    }
  }

  private setFilter(filter: string): void {
    this.filter = filter;
    this.cursor = 0;
    this.offset = 0;
  }

  /** Marked item indices in their original order. */
  result(): number[] {
    return [...this.selected].sort((a, b) => a - b);
  }

  /**
   * The full frame as lines: title, two help lines, the list region (list and
   * preview), status. `preview` gives the preview lines of an item.
   */
  view(
    region: number,
    width: number,
    preview: (index: number) => string[],
  ): Line[] {
    const visible = this.visible();
    const rows = this.rows(visible);
    this.settle(rows, region);
    const listRows = this.listRows(region);
    const lines: Line[] = [];

    // The filter lives in the title line, so the header needs no extra row.
    let title = this.title;
    if (this.filtering) title += `   filter: ${this.filter}▏`;
    else if (this.filter) title += `   filter: ${this.filter}  (f to edit)`;
    lines.push({ text: title, color: "cyan" });

    const [help1, help2] = wrapKeys(this.helpKeys(), width);
    lines.push({ text: help1, color: "gray" }, { text: help2, color: "gray" });

    for (let r = 0; r < listRows; r++) {
      const vi = this.offset + r;
      const row = rows[vi];
      lines.push(row ? this.rowLine(row, vi === this.cursor) : { text: "" });
    }

    // Rows below the list: preview, or blank when it is off.
    if (this.previewOn) {
      let pv: string[] = [];
      const cur = rows[this.cursor];
      if (cur?.kind === "dir")
        pv = [`${cur.leaves.length} entries in this folder`];
      else if (cur) pv = preview(cur.index).slice(0, PREVIEW_ROWS - 1);
      lines.push({ text: "── preview ──", color: "blue" });
      for (let k = 0; k < PREVIEW_ROWS - 1; k++) {
        const t = pv[k];
        lines.push(
          t === undefined
            ? { text: "" }
            : { text: "  " + t.replaceAll("\t", "  "), color: "gray" },
        );
      }
    }

    const first = rows.length ? this.offset + 1 : 0;
    const lastShown = Math.min(this.offset + listRows, rows.length);
    let status = `${this.selected.size} marked · rows ${first}-${lastShown} of ${rows.length} · on row ${rows.length ? this.cursor + 1 : 0}`;
    if (this.treeMode) status += " · tree";
    if (this.filter)
      status += ` (filter matches ${visible.length} of ${this.texts.length} entries)`;
    else if (lastShown < rows.length) status += " (↓ for more)";
    if (this.flagCount > 0)
      status += ` · ${this.flagCount} ${this.flagLabel} (red)`;
    lines.push({ text: status, color: "blue" });

    return lines;
  }

  private helpKeys(): string[] {
    const keys = ["[↑↓] move", "[Space] mark", "[a] all matching", "[n] none"];
    if (this.flagCount > 0 && !this.noFlagKey)
      keys.push(`[d] ${this.flagLabel}`);
    if (this.treeAllowed)
      keys.push(...(this.treeMode ? ["[←→] fold", "[g] list"] : ["[g] tree"]));
    if (this.hasPreview) keys.push("[p] preview");
    for (const a of this.actions) keys.push(`[${a.key}] ${a.label}`);
    keys.push("[f] filter", "[Enter] done", "[Esc/Ctrl+C] cancel");
    return keys;
  }

  private rowLine(row: Row, current: boolean): Line {
    const arrow = current ? ">" : " ";
    const indent = "  ".repeat(row.depth);
    const on = row.leaves.filter((i) => this.selected.has(i)).length;
    const all = on === row.leaves.length;
    let text: string;
    let color: Color | undefined;
    if (row.kind === "dir") {
      const mark = on === 0 ? "[ ]" : all ? "[x]" : "[-]";
      const glyph = row.open ? "▾" : "▸";
      const allFlagged =
        this.flagCount > 0 && row.leaves.every((i) => this.flags[i]);
      color = allFlagged ? "red" : all ? "green" : "cyan";
      text = `${arrow} ${indent}${mark} ${glyph} ${row.text}  (${row.leaves.length})`;
    } else {
      const pad = this.treeMode ? "  " : "";
      color = this.flags[row.index] ? "red" : all ? "green" : undefined;
      text = `${arrow} ${indent}${all ? "[x]" : "[ ]"} ${pad}${row.text}`;
    }
    const line: Line = { text, highlight: current };
    if (color) line.color = color;
    return line;
  }
}

interface TreeNode {
  name: string;
  id: string;
  dirs: Map<string, TreeNode>;
  files: { index: number; label: string }[];
  all: number[];
}

function newNode(name: string, id: string): TreeNode {
  return { name, id, dirs: new Map(), files: [], all: [] };
}

function compare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base" });
}

/** Help keys on two lines, wrapped at a key boundary. */
export function wrapKeys(keys: string[], width: number): [string, string] {
  let one = "";
  let two = "";
  for (const k of keys) {
    if (!two && one.length + k.length + 3 <= width)
      one += (one ? " · " : "") + k;
    else two += (two ? " · " : "") + k;
  }
  return [one, two];
}

/** Height of the list region for a terminal of the given height. */
export function regionHeight(
  itemCount: number,
  terminalRows: number,
  preview: boolean,
): number {
  return preview
    ? Math.max(
        PREVIEW_ROWS + 3,
        Math.min(itemCount + PREVIEW_ROWS, terminalRows - 6),
      )
    : Math.max(3, Math.min(itemCount, terminalRows - 6));
}
