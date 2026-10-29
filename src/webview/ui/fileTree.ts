import "./fileTree.css";
import { codiconElement, type Codicon } from "../codicons";
import { h } from "../dom";
import { updateTreeToggle } from "../treeToggle";
import { renderLines } from "./counts";
import { nameClass, renderStatus } from "./fileStatus";
import { filterTree, findByPrefix, flattenTree, keepShown, pick, rowWindow, scrollToShow, treeKey, type FlatRow, type Selection, type TreeItem } from "./fileTreeModel";

/** Every row's height, as both views drew it. */
export const ROW_HEIGHT = 25;
/** The space above the first row and below the last. */
const PAD_TOP = 2;
const PAD_BOTTOM = 8;
/** Rows drawn beyond the screen each way, so a scroll or a held key shows no gap. */
const OVERSCAN = 8;
/** Type-to-find: letters typed within this many ms make one name. */
const TYPE_DELAY = 700;

/** What a row draws, in this order: twisty, icon, name, old path, note, + −, description, status letter. */
export interface RowParts {
  icon: "file" | "folder" | "repo" | "commit" | "none";
  label: string;
  /** A row that loads more ("Show 500 more"), in the link color. */
  link?: boolean;
  /** The row's change (its name in the status color, struck through when deleted). */
  status?: string;
  untracked?: boolean;
  /** The status letter's column (files): empty when the file did not change. */
  letter?: boolean;
  /** A rename's old path, muted after the name. */
  oldPath?: string;
  /** Muted words before the counts: staged, binary, new, conflict, already on both. */
  note?: string;
  lines?: { added: number; deleted: number };
  /** Muted, at the end: a folder's count, a commit's author and hash. */
  description?: string;
  /** Already on both sides (dimmed), or conflicting (the conflict color). */
  same?: boolean;
  conflict?: boolean;
  title?: string;
  /** The row's data-vscode-context (its right-click menu). */
  context?: string;
}

export interface FileTreeOptions<N extends TreeItem<N>> {
  /** The scroll container, role="tree". */
  root: HTMLElement;
  /** Row element ids (aria-activedescendant): `${idPrefix}-1`, … */
  idPrefix: string;
  isBranch(node: N): boolean;
  /** Counts as a file: "3 of 301 files", Enter in the filter, what a filtered selection sends. */
  isFile(node: N): boolean;
  parts(node: N): RowParts;
  /** The row's own texts a filter looks in. */
  filterText(node: N): readonly (string | undefined)[];
  /** A branch a filter shows with only some of its rows. */
  remake(node: N, children: N[], files: number): N;
  /** A branch not read yet (a commit's files): a search never opens it, since each read is a git process. */
  isUnread?(node: N): boolean;
  /** Closed the first time it is seen (All Files' unchanged folders, Compare's commits). */
  startsClosed?(node: N): boolean;
  /** Enter or a click on a row that is not a branch: open its diff (or load more). */
  open(node: N): void;
  /** The user opened a branch. */
  opened?(node: N): void;
  /** An open branch has no rows read yet. */
  wantChildren?(node: N): void;
  /** The selection changed: its ids (while filtering, only the files shown). */
  selectionChanged(ids: string[]): void;
  /** The tree's own open and closed folders changed (the view keeps them). */
  closedChanged?(): void;
  /** Collapse All / Expand All. */
  toggleButton?: HTMLButtonElement;
  /** Expand All was pressed: the host may read what is not read yet. */
  expandedAll?(searching: boolean): void;
  /** After the shown rows change: the filter's counts. */
  refreshed?(info: { searching: boolean; matched: number; total: number; rows: number }): void;
}

interface Drawn<N> {
  el: HTMLElement;
  node: N;
  depth: number;
  expanded: boolean;
  posinset: number;
  setsize: number;
  index: number;
  selected: boolean;
  focused: boolean;
}

/** File icons in the theme's colors: a few languages get their mark, the rest VS Code's file icon. */
const TYPES: Record<string, [string, string]> = {
  js: ["js", "JS"], jsx: ["js", "JS"], mjs: ["js", "JS"], cjs: ["js", "JS"], ts: ["ts", "TS"], tsx: ["ts", "TS"], mts: ["ts", "TS"], cts: ["ts", "TS"],
  vue: ["vue", "V"], json: ["json", "{}"], css: ["css", "#"], scss: ["css", "#"], less: ["css", "#"], md: ["md", "M↓"], html: ["html", "<>"], htm: ["html", "<>"],
};

/** VS Code's icons, built once and cloned for each row. */
const icons = new Map<Codicon, SVGElement>();
function iconOf(name: Codicon): SVGElement {
  let icon = icons.get(name);
  if (!icon) icons.set(name, icon = codiconElement(name));
  return icon.cloneNode(true) as SVGElement;
}

function iconElement(p: RowParts): HTMLElement {
  if (p.icon === "file") {
    const type = TYPES[p.label.slice(p.label.lastIndexOf(".") + 1).toLowerCase()];
    if (type && p.label.includes(".")) return h("span", { class: `ftree-icon ftree-type-${type[0]}`, "aria-hidden": "true" }, [type[1]]);
  }
  const name = ({ file: "file", folder: "folder", repo: "repo", commit: "git-commit", none: undefined } as const)[p.icon];
  return h("span", { class: "ftree-icon", "aria-hidden": "true" }, name ? [iconOf(name)] : []);
}

/**
 * One tree of changed files, the same in the Changes view and in Compare's sides, drawn and keyed
 * as VS Code's own trees are (the Commit side bar's native one). Only the rows on screen exist; a
 * row is drawn again only when what it shows changed, and selecting or moving the focus touches
 * two rows. Each view says what a row draws and what to tell the host.
 */
export class FileTree<N extends TreeItem<N>> {
  private readonly root: HTMLElement;
  private readonly sizer: HTMLElement;
  private roots: readonly N[] = [];
  private searchRoots: readonly N[] | undefined;
  private shownRoots: readonly N[] = [];
  private query = "";
  /** The tree's closed branches; a search keeps its own, from all open. */
  private closed = new Set<string>();
  private searchOpen = new Map<string, boolean>();
  private readonly seen = new Set<string>();
  /** Expand All was the last of the two: branches seen later start open too. */
  private allOpen = false;
  private sel: Selection = { selected: new Set() };
  private rows: FlatRow<N>[] = [];
  private ids: string[] = [];
  private index = new Map<string, number>();
  private readonly drawn = new Map<string, Drawn<N>>();
  private readonly elementIds = new Map<string, string>();
  private top = 0;
  private height = 0;
  private activeId: string | undefined;
  /** The selection the view was last told (undefined: tell it the next one). */
  private posted: string | undefined;
  private typed = "";
  private typedAt = -Infinity;
  private filterInput: HTMLInputElement | undefined;
  private counts = { matched: 0, total: 0 };

  constructor(private readonly o: FileTreeOptions<N>) {
    const root = this.root = o.root;
    root.classList.add("ftree");
    this.sizer = h("div", { class: "ftree-sizer", role: "none" });
    root.replaceChildren(this.sizer);
    root.addEventListener("click", (e) => this.click(e));
    // Shift-click selects rows, not their text.
    root.addEventListener("mousedown", (e) => { if (e.shiftKey) e.preventDefault(); });
    root.addEventListener("contextmenu", (e) => {
      const index = this.indexAt(e.target);
      // Right-click inside the selection keeps it (the menu acts on all of it); outside, it selects that row.
      if (index !== undefined && !this.sel.selected.has(this.ids[index])) this.choose(index, "only");
    });
    root.addEventListener("keydown", (e) => this.key(e));
    // As VS Code's lists: the tree takes the focus on its first row, not selecting it.
    root.addEventListener("focus", () => {
      if (this.focusIndex() < 0 && this.rows.length) { this.sel = { ...this.sel, focus: this.ids[0] }; this.render(); }
    });
    root.addEventListener("scroll", () => { this.top = root.scrollTop; this.render(); }, { passive: true });
    new ResizeObserver(([entry]) => {
      const height = entry.contentRect.height;
      if (height !== this.height) { this.height = height; this.render(); }
    }).observe(root);
    const button = o.toggleButton;
    button?.addEventListener("click", () => (button.dataset.action === "collapse" ? this.collapseAll() : this.expandAll()));
  }

  get searching(): boolean {
    return this.query.trim() !== "";
  }

  /** The tree's closed branches (the view keeps them across reloads). */
  get closedIds(): string[] {
    return [...this.closed];
  }

  set closedIds(ids: Iterable<string>) {
    this.closed = new Set(ids);
  }

  /** Another page (another commit, another pair): nothing of the last one's state is kept. */
  reset(): void {
    this.closed.clear();
    this.seen.clear();
    this.searchOpen.clear();
    this.allOpen = false;
    this.sel = { selected: new Set() };
    this.posted = undefined;
    this.top = 0;
    this.root.scrollTop = 0;
    for (const d of this.drawn.values()) d.el.remove();
    this.drawn.clear();
    this.elementIds.clear();
  }

  /** The host's rows; `searchRoots`, when the shown tree is not all a search looks in (All Files). */
  setRoots(roots: readonly N[], searchRoots?: readonly N[]): void {
    this.roots = roots;
    this.searchRoots = searchRoots;
    const walk = (nodes: readonly N[]) => {
      for (const node of nodes) {
        if (!this.seen.has(node.id)) {
          this.seen.add(node.id);
          if (!this.allOpen && this.o.startsClosed?.(node)) this.closed.add(node.id);
        }
        if (node.children) walk(node.children);
      }
    };
    walk(roots);
    this.refresh();
  }

  /** The filter box drives the tree: Escape clears it, Enter opens the first file, ↓ goes into the tree, Ctrl+F in the tree comes back. */
  bindFilter(input: HTMLInputElement, changed?: () => void): void {
    this.filterInput = input;
    this.query = input.value;
    input.addEventListener("input", () => { this.setQuery(input.value); changed?.(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && input.value) {
        e.preventDefault();
        input.value = "";
        this.setQuery("");
        changed?.();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const first = this.rows.findIndex((r) => this.o.isFile(r.node));
        if (first < 0) return;
        this.choose(first, "only");
        this.root.focus();
        this.o.open(this.rows[first].node);
      } else if (e.key === "ArrowDown" && this.rows.length) {
        e.preventDefault();
        this.root.focus();
        this.choose(Math.max(0, this.focusIndex()), "only");
      }
    });
  }

  setQuery(query: string): void {
    this.query = query;
    this.searchOpen.clear();
    this.top = 0;
    this.root.scrollTop = 0;
    this.refresh();
  }

  /** Opens the branches on the way to a row, then selects it and scrolls it into view. */
  reveal(id: string): boolean {
    const path: string[] = [];
    const find = (nodes: readonly N[]): boolean => nodes.some((node) => {
      if (node.id === id) return true;
      if (node.children && find(node.children)) { path.push(node.id); return true; }
      return false;
    });
    if (!find(this.roots)) return false;
    for (const branch of path) this.closed.delete(branch);
    this.refresh();
    const index = this.index.get(id);
    if (index === undefined) return false;
    this.choose(index, "only");
    return true;
  }

  focus(): void {
    this.root.focus();
  }

  collapseAll(): void {
    this.allOpen = false;
    this.setAll(false);
  }

  expandAll(): void {
    this.allOpen = true;
    this.o.expandedAll?.(this.searching);
    this.setAll(true);
  }

  private setAll(open: boolean): void {
    if (this.searching) {
      const walk = (nodes: readonly N[]) => nodes.forEach((n) => { if (this.o.isBranch(n)) { this.searchOpen.set(n.id, open); walk(n.children ?? []); } });
      walk(this.shownRoots);
    } else if (open) this.closed.clear();
    else {
      const walk = (nodes: readonly N[]) => nodes.forEach((n) => { if (this.o.isBranch(n)) { this.closed.add(n.id); walk(n.children ?? []); } });
      walk(this.roots);
    }
    this.o.closedChanged?.();
    this.refresh();
  }

  private isOpen(node: N): boolean {
    if (!this.searching) return !this.closed.has(node.id);
    return this.searchOpen.get(node.id) ?? !this.o.isUnread?.(node);
  }

  private focusIndex(): number {
    return this.sel.focus === undefined ? -1 : this.index.get(this.sel.focus) ?? -1;
  }

  /** The shown rows again: the filter, the open branches, the selection kept to what is shown. */
  private refresh(): void {
    const searching = this.searching;
    const filtered = filterTree(searching ? this.searchRoots ?? this.roots : this.roots, this.query, {
      isBranch: (n) => this.o.isBranch(n), isFile: (n) => this.o.isFile(n), text: (n) => this.o.filterText(n), remake: (n, c, f) => this.o.remake(n, c, f),
    });
    this.shownRoots = filtered.roots;
    this.counts = { matched: filtered.matched, total: filtered.total };
    // The focused row's parents, nearest first: a collapse that hides it moves the focus there.
    const parents: string[] = [];
    for (let i = this.rows[this.focusIndex()]?.parent ?? -1; i >= 0; i = this.rows[i].parent) parents.push(this.ids[i]);
    this.rows = flattenTree(filtered.roots, (n) => this.o.isBranch(n), (n) => this.isOpen(n));
    this.ids = this.rows.map((r) => r.node.id);
    this.index = new Map(this.ids.map((id, i) => [id, i]));
    this.sel = keepShown(this.sel, this.index, parents);
    for (const r of this.rows) if (r.expanded && this.o.isUnread?.(r.node)) this.o.wantChildren?.(r.node);
    if (this.o.toggleButton) updateTreeToggle(this.o.toggleButton, this.rows.some((r) => r.branch), this.rows.some((r) => r.expanded));
    this.root.classList.toggle("ftree-empty", this.rows.length === 0);
    const height = this.rows.length ? PAD_TOP + this.rows.length * ROW_HEIGHT + PAD_BOTTOM : 0;
    this.sizer.style.height = `${height}px`;
    this.top = Math.max(0, Math.min(this.top, height - this.viewHeight()));
    this.render();
    this.post();
    this.o.refreshed?.({ searching, matched: this.counts.matched, total: this.counts.total, rows: this.rows.length });
  }

  private viewHeight(): number {
    return this.height || this.root.clientHeight;
  }

  /** Draws the rows on screen and the focused one; a row whose node, depth and state are the same keeps its element. */
  private render(): void {
    // Before the first resize report the height is not known: draw enough for a tall view.
    const { start, end } = rowWindow(this.top, this.height || 900, this.rows.length, ROW_HEIGHT, PAD_TOP, OVERSCAN);
    const wanted: number[] = [];
    for (let i = start; i < end; i++) wanted.push(i);
    const focus = this.focusIndex();
    if (focus >= 0 && (focus < start || focus >= end)) wanted.push(focus);
    wanted.sort((a, b) => a - b);
    // Rows that left the screen go first: the ones that stay are then already in order, and none moves.
    const keep = new Set(wanted.map((i) => this.ids[i]));
    for (const [id, d] of this.drawn) if (!keep.has(id)) { d.el.remove(); this.drawn.delete(id); }
    let previous: Element | null = null;
    for (const i of wanted) {
      const row = this.rows[i];
      const id = row.node.id;
      let d = this.drawn.get(id);
      if (!d || d.node !== row.node || d.depth !== row.depth || d.expanded !== row.expanded || d.posinset !== row.posinset || d.setsize !== row.setsize) {
        const el = this.build(row);
        d?.el.replaceWith(el);
        d = { el, node: row.node, depth: row.depth, expanded: row.expanded, posinset: row.posinset, setsize: row.setsize, index: -1, selected: false, focused: false };
        this.drawn.set(id, d);
      }
      if (d.index !== i) { d.index = i; d.el.style.top = `${PAD_TOP + i * ROW_HEIGHT}px`; }
      const selected = this.sel.selected.has(id), focused = id === this.sel.focus;
      if (d.selected !== selected) { d.selected = selected; d.el.classList.toggle("selected", selected); d.el.setAttribute("aria-selected", String(selected)); }
      if (d.focused !== focused) { d.focused = focused; d.el.classList.toggle("focused", focused); }
      // In row order, so a screen reader's reading order is the tree's.
      const next: Element | null = previous ? previous.nextElementSibling : this.sizer.firstElementChild;
      if (next !== d.el) this.sizer.insertBefore(d.el, next);
      previous = d.el;
    }
    const active = this.sel.focus !== undefined ? this.drawn.get(this.sel.focus)?.el.id : undefined;
    if (active !== this.activeId) {
      this.activeId = active;
      if (active) this.root.setAttribute("aria-activedescendant", active);
      else this.root.removeAttribute("aria-activedescendant");
    }
  }

  private elementId(id: string): string {
    let el = this.elementIds.get(id);
    if (!el) this.elementIds.set(id, el = `${this.o.idPrefix}-${this.elementIds.size + 1}`);
    return el;
  }

  private build(row: FlatRow<N>): HTMLElement {
    const p = this.o.parts(row.node);
    const flags = `${p.status ? ` status-${p.status}` : ""}${p.same ? " same" : ""}${p.conflict ? " conflict" : ""}`;
    const el = h("div", { class: `ftree-row${flags}`, role: "treeitem", id: this.elementId(row.node.id), "aria-level": String(row.depth),
      "aria-setsize": String(row.setsize), "aria-posinset": String(row.posinset), "aria-expanded": row.branch ? String(row.expanded) : undefined,
      "aria-selected": "false", "data-node": encodeURIComponent(row.node.id), title: p.title || undefined, "data-vscode-context": p.context });
    el.style.paddingLeft = `${8 + (row.depth - 1) * 14}px`;
    const end = [
      p.note ? h("span", { class: "ftree-note" }, [p.note]) : null,
      p.lines ? renderLines(p.lines.added, p.lines.deleted) : null,
      p.description ? h("span", { class: "ftree-description" }, [p.description]) : null,
    ].filter((c): c is HTMLElement => c !== null);
    el.append(
      h("span", { class: "ftree-twisty", "aria-hidden": "true", "data-toggle": row.branch }, row.branch ? [iconOf("chevron-right")] : []),
      iconElement(p),
      h("span", { class: `${nameClass("ftree-label", p.status)}${p.link ? " ftree-link" : ""}` }, [p.label]),
    );
    if (p.oldPath) el.append(h("span", { class: "ftree-old-path", title: p.oldPath }, [`← ${p.oldPath}`]));
    if (end.length) el.append(h("span", { class: "ftree-end" }, end));
    if (p.letter) el.append(renderStatus(p.status, p.untracked === true, "ftree-status"));
    return el;
  }

  private indexAt(target: EventTarget | null): number | undefined {
    const el = (target as Element | null)?.closest?.<HTMLElement>(".ftree-row");
    return el && this.root.contains(el) ? this.index.get(decodeURIComponent(el.dataset.node ?? "")) : undefined;
  }

  private click(e: MouseEvent): void {
    const index = this.indexAt(e.target);
    if (index === undefined) return;
    const row = this.rows[index];
    this.root.focus({ preventScroll: true });
    // The twisty opens or closes the branch alone: the selection stays.
    if ((e.target as Element).closest("[data-toggle]")) {
      this.sel = { ...this.sel, focus: row.node.id };
      this.toggle(index);
      return;
    }
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.shiftKey) this.choose(index, "range", ctrl);
    else if (ctrl) this.choose(index, "toggle");
    else {
      this.choose(index, "only");
      if (row.branch) this.toggle(index);
      else this.o.open(row.node);
    }
  }

  private key(e: KeyboardEvent): void {
    if (e.altKey) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && e.key.toLowerCase() === "f" && this.filterInput) {
      e.preventDefault();
      this.filterInput.focus();
      this.filterInput.select();
      return;
    }
    if (this.typeToFind(e)) return;
    const action = treeKey(this.rows, this.focusIndex(), e.key, { shift: e.shiftKey, ctrl }, Math.floor(this.viewHeight() / ROW_HEIGHT));
    if (!action) return;
    e.preventDefault();
    switch (action.type) {
      case "move": this.choose(action.index, action.mode, ctrl); return;
      case "select": this.choose(action.index, action.mode); return;
      case "toggle": this.toggle(action.index); return;
      case "open": this.o.open(this.rows[action.index].node); return;
      case "selectAll":
        this.sel = { ...this.sel, selected: new Set(this.ids) };
        this.render();
        this.post();
    }
  }

  /** A name's first letters, typed in the tree, go to the next row with that name. */
  private typeToFind(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.key.length !== 1 || e.key.trim() === "" || this.rows.length === 0) return false;
    const now = e.timeStamp;
    this.typed = now - this.typedAt > TYPE_DELAY ? e.key : this.typed + e.key;
    this.typedAt = now;
    e.preventDefault();
    const index = findByPrefix(this.rows.map((r) => r.node.label), this.focusIndex(), this.typed);
    if (index >= 0) this.choose(index, "only");
    return true;
  }

  private choose(index: number, mode: "only" | "toggle" | "range" | "focus", add = false): void {
    this.sel = pick(this.ids, this.sel, this.ids[index], mode, add);
    const top = scrollToShow(this.top, this.viewHeight(), index, ROW_HEIGHT, PAD_TOP);
    if (top !== this.top) {
      this.top = top;
      this.root.scrollTop = top;
    }
    this.render();
    this.post();
  }

  private toggle(index: number): void {
    const row = this.rows[index];
    if (!row?.branch) return;
    const id = row.node.id, open = !row.expanded;
    if (this.searching) this.searchOpen.set(id, open);
    else if (open) this.closed.delete(id);
    else this.closed.add(id);
    if (open) this.o.opened?.(row.node);
    this.o.closedChanged?.();
    this.refresh();
  }

  private post(): void {
    // A filtered folder stands for its shown files only: the host must not take the hidden ones too.
    const ids = this.searching
      ? [...this.sel.selected].filter((id) => { const i = this.index.get(id); return i !== undefined && this.o.isFile(this.rows[i].node); })
      : [...this.sel.selected];
    const key = JSON.stringify(ids);
    if (key === this.posted) return;
    this.posted = key;
    this.o.selectionChanged(ids);
  }
}
