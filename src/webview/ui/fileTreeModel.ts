// One tree of changed files, the same in the Changes view and in Compare's sides: the rows it
// shows, what a filter keeps, what each key does, which rows are selected, and which rows are on
// screen. Pure: no DOM, no vscode import (ui/fileTree.ts draws it).

/** A row as a host sends it: an id, a name, and the rows it opens onto. */
export interface TreeItem<N> {
  id: string;
  label: string;
  children?: readonly N[];
}

/** A shown row, in order: its depth (1 at the top), its parent's index (-1 at the top), its place among its siblings. */
export interface FlatRow<N> {
  node: N;
  depth: number;
  parent: number;
  /** Opens onto other rows (a folder, a repository, a commit). */
  branch: boolean;
  /** A branch whose rows show below it. */
  expanded: boolean;
  posinset: number;
  setsize: number;
}

/** The rows shown, top to bottom: a branch's rows follow it while it is open. */
export function flattenTree<N extends TreeItem<N>>(roots: readonly N[], isBranch: (node: N) => boolean, isOpen: (node: N) => boolean): FlatRow<N>[] {
  const rows: FlatRow<N>[] = [];
  const walk = (nodes: readonly N[], depth: number, parent: number) => {
    nodes.forEach((node, i) => {
      const branch = isBranch(node);
      const expanded = branch && isOpen(node);
      const index = rows.push({ node, depth, parent, branch, expanded, posinset: i + 1, setsize: nodes.length }) - 1;
      if (expanded) walk(node.children ?? [], depth + 1, index);
    });
  };
  walk(roots, 1, -1);
  return rows;
}

/** What a filter compares: lowercased, Windows separators as git writes them. */
export const normalizeText = (text: string): string => text.replace(/\\/g, "/").toLowerCase();

export interface FilterOptions<N> {
  isBranch(node: N): boolean;
  /** Counts in "3 of 301 files" (a "Show 500 more" row does not). */
  isFile(node: N): boolean;
  /** The row's own texts a term is looked for in: a file's name, path and old path; a commit's subject, author and hash. */
  text(node: N): readonly (string | undefined)[];
  /** A branch shown with only some of its rows: the copy to draw (its count says how many files are shown). */
  remake(node: N, children: N[], files: number): N;
}

export interface Filtered<N> {
  roots: readonly N[];
  /** Files shown, and files in the whole tree. */
  matched: number;
  total: number;
}

/**
 * A view-only projection: a row shows when its own text has the term, with every row under it, or
 * when a row under it does, with only those. Rows keep their host ids; a branch shown in part is a
 * copy (`remake`).
 */
export function filterTree<N extends TreeItem<N>>(roots: readonly N[], query: string, o: FilterOptions<N>): Filtered<N> {
  const term = normalizeText(query.trim());
  let total = 0;
  let matched = 0;
  const filesIn = (node: N): number => (o.isBranch(node) ? (node.children ?? []).reduce((n, c) => n + filesIn(c), 0) : o.isFile(node) ? 1 : 0);
  if (!term) {
    total = matched = roots.reduce((n, r) => n + filesIn(r), 0);
    return { roots, matched, total };
  }
  const has = (node: N) => o.text(node).some((text) => text !== undefined && normalizeText(text).includes(term));
  const walk = (nodes: readonly N[]): { nodes: N[]; files: number } => {
    const shown: N[] = [];
    let files = 0;
    for (const node of nodes) {
      if (has(node)) {
        const n = filesIn(node);
        total += n;
        matched += n;
        files += n;
        shown.push(node);
      } else if (o.isBranch(node)) {
        const below = walk(node.children ?? []);
        if (below.nodes.length) {
          files += below.files;
          shown.push(o.remake(node, below.nodes, below.files));
        }
      } else if (o.isFile(node)) total++;
    }
    return { nodes: shown, files };
  };
  return { roots: walk(roots).nodes, matched, total };
}

export interface KeyMods {
  shift: boolean;
  /** Ctrl, or ⌘ on macOS. */
  ctrl: boolean;
}

/**
 * What a key does to the tree. move: the focus goes to a row and selects it alone ("only"), selects
 * the range from the anchor ("range"), or leaves the selection ("focus"). select: the focused row
 * alone, toggled in or out, or the range to it. toggle: a branch opens or closes. open: a file's diff.
 */
export type TreeAction =
  | { type: "move"; index: number; mode: "only" | "range" | "focus" }
  | { type: "select"; index: number; mode: "only" | "toggle" | "range" }
  | { type: "toggle"; index: number }
  | { type: "open"; index: number }
  | { type: "selectAll" };

const NAVIGATION = new Set(["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]);

/** The row a navigation key goes to from `focus` (-1: none yet, so ↓ goes to the first). */
export function navigate(key: string, focus: number, total: number, pageRows: number): number | null {
  if (total === 0 || !NAVIGATION.has(key)) return null;
  const last = total - 1;
  const from = Math.min(last, focus);
  switch (key) {
    case "ArrowDown": return Math.min(last, from + 1);
    case "ArrowUp": return Math.max(0, from - 1);
    case "Home": return 0;
    case "End": return last;
    case "PageDown": return Math.min(last, Math.max(0, from) + pageRows);
    default: return Math.max(0, from - pageRows);
  }
}

/**
 * The tree's keys, as VS Code's lists have them: ↑ ↓ Home End PageUp PageDown move (Shift extends
 * the range, Ctrl moves the focus alone); → opens a folder or goes to its first row, ← closes it or
 * goes to its parent; Enter opens a file or toggles a folder; Space toggles a folder or selects a
 * file (Ctrl toggles the row in the selection, Shift selects the range); Ctrl+A selects every row.
 */
export function treeKey(rows: readonly Pick<FlatRow<unknown>, "branch" | "expanded" | "parent">[], focus: number, key: string, mods: KeyMods, pageRows: number): TreeAction | null {
  const next = navigate(key, focus, rows.length, Math.max(1, pageRows));
  if (next !== null) return { type: "move", index: next, mode: mods.shift ? "range" : mods.ctrl ? "focus" : "only" };
  if (mods.ctrl && !mods.shift && key.toLowerCase() === "a") return rows.length ? { type: "selectAll" } : null;
  const row = rows[focus];
  if (!row) return null;
  switch (key) {
    case "Enter": return row.branch ? { type: "toggle", index: focus } : { type: "open", index: focus };
    case " ":
      if (mods.ctrl) return { type: "select", index: focus, mode: "toggle" };
      if (mods.shift) return { type: "select", index: focus, mode: "range" };
      return row.branch ? { type: "toggle", index: focus } : { type: "select", index: focus, mode: "only" };
    case "ArrowRight":
      if (!row.branch) return null;
      if (!row.expanded) return { type: "toggle", index: focus };
      return rows[focus + 1]?.parent === focus ? { type: "move", index: focus + 1, mode: "only" } : null;
    case "ArrowLeft":
      if (row.branch && row.expanded) return { type: "toggle", index: focus };
      return row.parent >= 0 ? { type: "move", index: row.parent, mode: "only" } : null;
    default: return null;
  }
}

/** The selected rows (by id), the focused one, and where a Shift range starts. */
export interface Selection {
  selected: ReadonlySet<string>;
  focus?: string;
  anchor?: string;
}

/**
 * A row picked by the mouse or a key. only: it alone; toggle: in or out (Ctrl-click); range: the
 * rows from the anchor to it (Shift-click), added to the selection with `add` (Ctrl+Shift-click);
 * focus: the focus moves, the selection stays.
 */
export function pick(ids: readonly string[], s: Selection, id: string, mode: "only" | "toggle" | "range" | "focus", add = false): Selection {
  if (mode === "focus") return { ...s, focus: id };
  if (mode === "range") {
    const to = ids.indexOf(id);
    const at = s.anchor === undefined ? -1 : ids.indexOf(s.anchor);
    const from = at < 0 ? to : at;
    const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
    return { selected: new Set([...(add ? s.selected : []), ...range]), focus: id, anchor: at < 0 ? id : s.anchor };
  }
  if (mode === "toggle") {
    const selected = new Set(s.selected);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    return { selected, focus: id, anchor: id };
  }
  return { selected: new Set([id]), focus: id, anchor: id };
}

/** The selection with only the rows still shown; the focus, if its row went, goes to its nearest shown parent. */
export function keepShown(s: Selection, shown: ReadonlySet<string>, parentsOfFocus: readonly string[] = []): Selection {
  const selected = new Set([...s.selected].filter((id) => shown.has(id)));
  const focus = s.focus !== undefined && shown.has(s.focus) ? s.focus : parentsOfFocus.find((id) => shown.has(id));
  return { selected, focus, anchor: s.anchor !== undefined && shown.has(s.anchor) ? s.anchor : undefined };
}

/**
 * Type-to-find: the row whose name starts with what was typed, from the focused one on (it stays
 * while it still matches) and around. The same letter typed again goes to the next such row.
 */
export function findByPrefix(labels: readonly string[], focus: number, typed: string): number {
  const text = typed.toLowerCase();
  if (!text || labels.length === 0) return -1;
  const cycling = text.length > 1 && [...text].every((c) => c === text[0]);
  const prefix = cycling ? text[0] : text;
  const start = cycling || text.length === 1 ? focus + 1 : Math.max(0, focus);
  for (let i = 0; i < labels.length; i++) {
    const index = (((start + i) % labels.length) + labels.length) % labels.length;
    if (labels[index].toLowerCase().startsWith(prefix)) return index;
  }
  return -1;
}

/** The rows on screen (and `overscan` more each side): [start, end). `pad` is the space above the first row. */
export function rowWindow(scrollTop: number, height: number, total: number, rowHeight: number, pad = 0, overscan = 6): { start: number; end: number } {
  if (total === 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop - pad) / rowHeight);
  const last = Math.ceil(Math.max(0, scrollTop + height - pad) / rowHeight);
  return { start: Math.max(0, Math.min(total, first - overscan)), end: Math.max(0, Math.min(total, last + overscan)) };
}

/** The scroll position that shows a row whole, moving as little as it can (as scrollIntoView "nearest"). */
export function scrollToShow(scrollTop: number, height: number, index: number, rowHeight: number, pad = 0): number {
  const top = pad + index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + height) return Math.max(0, top + rowHeight - height);
  return scrollTop;
}
