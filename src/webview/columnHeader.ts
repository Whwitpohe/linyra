import "./columnHeader.css";
import type { ChangesMode } from "../changeStats";
import { localize } from "../i18n";
import { codiconElement } from "./codicons";
import { h } from "./dom";
import type { ColumnId, ColumnLayout, ColumnPrefs, SizedColumn } from "./logColumns";
import { showMenu, type MenuEntry } from "./ui/menu";

/** What the header shows besides the columns: each column's option, and the filters it opens. */
export interface HeaderState {
  history: boolean;
  sort: "date" | "topo";
  folds: { canCollapse: boolean; canExpand: boolean };
  changes: ChangesMode;
  hash: boolean;
  prefs: ColumnPrefs;
  authorFiltered: boolean;
  dateFiltered: boolean;
  /** A hash lookup ignores the other filters and the order (filters.ts disables them): so does the Graph menu. */
  hashLookup: boolean;
}

/** What the header asks of the Log (main.ts): each runs what the ⋯ menu and the filter bar already run. */
export interface HeaderActions {
  sort(order: "date" | "topo"): void;
  fold(fold: "collapse" | "expand"): void;
  changes(mode: ChangesMode): void;
  hash(shown: boolean): void;
  prefs(next: ColumnPrefs): void;
  /** A sash being dragged: the columns at this width, drawn without saving (list.ts). */
  preview(column: SizedColumn, px: number | undefined): void;
  focusSearch(): void;
  authorFilter(anchor: HTMLElement): void;
  dateFilter(anchor: HTMLElement): void;
}

const LABELS: Record<ColumnId, string> = { repo: "Repository", graph: "Graph", message: "Message", file: "Change", hash: "Hash", author: "Author", changes: "Changes", date: "Date" };
const CHANGES: [Exclude<ChangesMode, "off">, string][] = [["numbers", "Numbers"], ["squares", "Squares"], ["bar", "Bar"], ["bipolar", "Bipolar Bar"]];
/** Columns left of Message size from their right edge; the others from their left. */
const LEFT_OF_MESSAGE = new Set<ColumnId>(["repo", "graph"]);

/**
 * The Log's column header, as GitLens's Commit Graph has one: a row of column headers inside the
 * grid, sticky over the commits, laid out by the same --log-columns as the rows (logColumns.ts), so
 * a cell is always under its header. A column's options are on its header, shown on hover or
 * focus (a filter that is on stays shown); a sash on its inner edge resizes it; right-click or the
 * gear opens Columns. One Tab stop: ← → move between its buttons.
 */
export class ColumnHeader {
  readonly el = h("div", { class: "column-header", role: "row", "aria-rowindex": "1" });
  private layout: ColumnLayout | undefined;
  private state: HeaderState | undefined;
  private drawn = "";
  /** The button that keeps the header's Tab stop. */
  private stop = "";

  constructor(private readonly actions: HeaderActions) {
    this.el.addEventListener("contextmenu", (e) => { e.preventDefault(); this.columnsMenu({ x: e.clientX, y: e.clientY }); });
    this.el.addEventListener("keydown", (e) => this.onKey(e));
    this.el.addEventListener("focusin", (e) => {
      const button = (e.target as Element).closest<HTMLButtonElement>("button");
      if (button?.dataset.key) this.rove(button.dataset.key);
    });
  }

  /** Drawn again only when its columns or its state changed (a scroll or a selection changes neither). */
  render(layout: ColumnLayout, state: HeaderState): void {
    this.layout = layout;
    this.state = state;
    const key = JSON.stringify([layout.columns.map((c) => c.id), layout.narrow, state]);
    if (key === this.drawn) return;
    this.drawn = key;
    const focused = this.el.contains(document.activeElement) ? (document.activeElement as HTMLElement).closest<HTMLElement>("[data-key]")?.dataset.key : undefined;
    this.el.replaceChildren(...layout.columns.map((c) => this.cell(c.id, state)));
    if (focused) this.el.querySelector<HTMLButtonElement>(`button[data-key="${focused}"]`)?.focus();
    if (!this.el.querySelector(`button[data-key="${this.stop}"]`)) this.stop = this.el.querySelector<HTMLButtonElement>("button[data-key]")?.dataset.key ?? "";
    this.rove(this.stop);
  }

  private cell(id: ColumnId, s: HeaderState): HTMLElement {
    const label = localize(LABELS[id]);
    const cell = h("div", { class: `column-head column-${id}`, role: "columnheader", "data-column": id, "aria-label": label });
    const tools = h("span", { class: "column-tools" });
    switch (id) {
      case "graph": {
        // The order the Log is in: the Graph column decides it, and its button says it.
        const order = localize(s.sort === "topo" ? "By branch structure" : "By commit date");
        const button = this.button("graph", localize("Graph: {0}", order), [codiconElement("git-commit"), codiconElement("chevron-down", "column-chevron")], (b) => this.graphMenu(b));
        button.classList.toggle("active", s.sort === "topo");
        button.setAttribute("aria-haspopup", "menu");
        cell.append(button);
        break;
      }
      case "message":
        cell.append(h("span", { class: "column-label" }, [label]));
        // Columns… sits here, the one column always shown and always wide enough for it.
        tools.append(this.tool("search", "search", localize("Search Commits"), () => this.actions.focusSearch()), this.gear());
        break;
      case "author":
        cell.append(h("span", { class: "column-label" }, [label]));
        tools.append(this.tool("author", s.authorFiltered ? "filter-filled" : "filter", localize(s.authorFiltered ? "Author filter is on: change it" : "Filter by Author"), (b) => this.actions.authorFilter(b), s.authorFiltered));
        break;
      case "changes": {
        const narrow = (this.width(id) ?? 0) < 72;
        const button = this.button("changes", `${label}: ${localize(CHANGES.find(([m]) => m === s.changes)?.[1] ?? "Bar")}`,
          [narrow ? codiconElement("diff") : h("span", { class: "column-label" }, [label]), codiconElement("chevron-down", "column-chevron")], (b) => this.changesMenu(b));
        button.setAttribute("aria-haspopup", "menu");
        cell.append(button);
        break;
      }
      case "date": {
        // The column is narrow: one button, its menu holding Filter by Date…; a range that is on
        // shows as the filled filter in place of the chevron, so it is seen without hovering.
        const format = localize(s.prefs.dates === "absolute" ? "Absolute" : "Relative");
        const button = this.button("date", s.dateFiltered ? localize("{0}: {1}, a date range is on", label, format) : `${label}: ${format}`,
          [h("span", { class: "column-label" }, [label]), s.dateFiltered ? codiconElement("filter-filled", "column-state") : codiconElement("chevron-down", "column-chevron")], (b) => this.dateMenu(b));
        button.setAttribute("aria-haspopup", "menu");
        button.classList.toggle("active", s.dateFiltered);
        cell.append(button);
        break;
      }
      default:
        cell.append(h("span", { class: "column-label" }, [label]));
    }
    if (tools.childElementCount > 0) cell.append(tools);
    if (this.layout && this.sizable(id)) cell.append(this.sash(id as SizedColumn));
    return cell;
  }

  private width(id: ColumnId): number | null | undefined {
    return this.layout?.columns.find((c) => c.id === id)?.px;
  }

  /** Sized columns, except a strip (the repository without its name) and the narrow layout's. */
  private sizable(id: ColumnId): boolean {
    if (!this.layout || this.layout.narrow) return false;
    if (id === "repo") return this.layout.repoName !== null;
    return ["graph", "hash", "author", "changes", "date"].includes(id);
  }

  private button(key: string, label: string, content: (Node | string)[], run: (b: HTMLButtonElement) => void): HTMLButtonElement {
    const b = h("button", { type: "button", class: "column-button", "data-key": key, title: label, "aria-label": label, tabindex: "-1" }, content);
    b.addEventListener("click", () => run(b));
    return b;
  }

  /** A column's option: shown on hover or focus, and always while it is on (a filter, the Repo List). */
  private tool(key: string, icon: Parameters<typeof codiconElement>[0], label: string, run: (b: HTMLButtonElement) => void, on = false): HTMLButtonElement {
    const b = this.button(key, label, [codiconElement(icon)], run);
    b.classList.add("column-tool");
    b.classList.toggle("active", on);
    return b;
  }

  private gear(): HTMLElement {
    const b = this.tool("columns", "settings-gear", localize("Columns…"), (button) => this.columnsMenu(button));
    b.classList.add("column-settings");
    b.setAttribute("aria-haspopup", "menu");
    return b;
  }

  private graphMenu(owner: HTMLButtonElement): void {
    const s = this.state!;
    const entries: MenuEntry[] = [
      { heading: localize("Order") },
      { label: localize("By commit date"), role: "radio", checked: s.sort !== "topo", disabled: s.hashLookup, run: () => this.actions.sort("date") },
      { label: localize("By branch structure"), role: "radio", checked: s.sort === "topo", disabled: s.hashLookup, run: () => this.actions.sort("topo") },
      ...(s.history ? [] : [{ separator: true } as const,
        { label: localize("Collapse Linear Branches"), disabled: !s.folds.canCollapse, run: () => this.actions.fold("collapse") },
        { label: localize("Expand Linear Branches"), disabled: !s.folds.canExpand, run: () => this.actions.fold("expand") }]),
    ];
    showMenu(owner, entries, { label: localize("Graph"), owner });
  }

  private changesMenu(owner: HTMLButtonElement): void {
    const s = this.state!;
    showMenu(owner, [
      { heading: localize("Show changes as") },
      ...CHANGES.map(([mode, label]): MenuEntry => ({ label: localize(label), role: "radio", checked: s.changes === mode, run: () => this.actions.changes(mode) })),
    ], { label: localize("Changes"), owner, align: "end" });
  }

  private dateMenu(owner: HTMLButtonElement): void {
    const s = this.state!;
    const set = (dates: ColumnPrefs["dates"]) => this.actions.prefs({ ...s.prefs, dates });
    showMenu(owner, [
      { label: localize("Relative (3 hours ago)"), role: "radio", checked: s.prefs.dates !== "absolute", run: () => set("relative") },
      { label: localize("Absolute (2026-10-29 21:14)"), role: "radio", checked: s.prefs.dates === "absolute", run: () => set("absolute") },
      { separator: true },
      { label: localize("Filter by Date…"), run: () => this.actions.dateFilter(owner) },
    ], { label: localize("Date"), owner, align: "end" });
  }

  /** Which optional columns show; Graph and Message always do. */
  private columnsMenu(at: HTMLElement | { x: number; y: number }): void {
    const s = this.state;
    if (!s) return;
    const hidden = new Set(s.prefs.hidden);
    const toggle = (id: "repo" | "author" | "date") => () => {
      const next = hidden.has(id) ? s.prefs.hidden.filter((x) => x !== id) : [...s.prefs.hidden, id];
      this.actions.prefs({ ...s.prefs, hidden: next });
    };
    const entries: MenuEntry[] = [
      { heading: localize("Columns") },
      ...(s.history ? [] : [{ label: localize("Repository Name"), role: "check", checked: !hidden.has("repo"), run: toggle("repo") } as const]),
      { label: localize("Hash"), role: "check", checked: s.hash, run: () => this.actions.hash(!s.hash) },
      { label: localize("Author"), role: "check", checked: !hidden.has("author"), run: toggle("author") },
      ...(s.history ? [] : [{ label: localize("Changes"), role: "check", checked: s.changes !== "off", run: () => this.actions.changes(s.changes === "off" ? "bar" : "off") } as const]),
      { label: localize("Date"), role: "check", checked: !hidden.has("date"), run: toggle("date") },
      { separator: true },
      { label: localize("Reset Column Widths"), disabled: Object.keys(s.prefs.widths).length === 0, run: () => this.actions.prefs({ ...s.prefs, widths: {} }) },
    ];
    showMenu(at, entries, { label: localize("Columns"), owner: this.el.querySelector<HTMLElement>(".column-settings") ?? undefined, align: "end" });
  }

  /**
   * A column's sash, on its edge toward Message. A drag redraws the columns each frame without
   * saving (the rows stay as they are); letting go saves the width; a double-click forgets it.
   */
  private sash(id: SizedColumn): HTMLElement {
    const side = LEFT_OF_MESSAGE.has(id) ? "right" : "left";
    const sash = h("div", { class: `column-sash ${side}`, "aria-hidden": "true", title: localize("Drag to resize; double-click for the automatic width") });
    sash.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.layout) return;
      e.stopPropagation();
      sash.setPointerCapture(e.pointerId);
      const start = this.layout.columns.find((c) => c.id === id)?.px ?? 0, x0 = e.clientX, sign = side === "right" ? 1 : -1;
      let width = start, frame = 0;
      sash.classList.add("dragging");
      const move = (ev: PointerEvent) => {
        width = Math.max(1, Math.round(start + sign * (ev.clientX - x0)));
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; this.actions.preview(id, width); });
      };
      const up = () => {
        sash.releasePointerCapture(e.pointerId);
        sash.removeEventListener("pointermove", move);
        sash.removeEventListener("pointerup", up);
        sash.removeEventListener("pointercancel", up);
        cancelAnimationFrame(frame);
        sash.classList.remove("dragging");
        const s = this.state!;
        if (width === start) { this.actions.preview(id, undefined); return; }
        this.actions.prefs({ ...s.prefs, widths: { ...s.prefs.widths, [id]: width } });
      };
      sash.addEventListener("pointermove", move);
      sash.addEventListener("pointerup", up);
      sash.addEventListener("pointercancel", up);
    });
    sash.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const s = this.state!;
      const widths = { ...s.prefs.widths };
      delete widths[id];
      this.actions.prefs({ ...s.prefs, widths });
    });
    return sash;
  }

  private buttons(): HTMLButtonElement[] {
    return [...this.el.querySelectorAll<HTMLButtonElement>("button[data-key]")];
  }

  /** One Tab stop: the last button used keeps it. */
  private rove(key: string): void {
    this.stop = key;
    for (const b of this.buttons()) b.tabIndex = b.dataset.key === key ? 0 : -1;
  }

  private onKey(e: KeyboardEvent): void {
    const list = this.buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    const go = (j: number) => { e.preventDefault(); e.stopPropagation(); list[(j + list.length) % list.length].focus(); };
    if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); this.columnsMenu(list[i]); }
  }
}
