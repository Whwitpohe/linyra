import { commitKey, type Commit } from "../types";
import { localize } from "../i18n";
import { referenceLabels } from "../commitReferences";
import { codiconElement } from "./codicons";
import { clear, h } from "./dom";
import { fitName, textStyle } from "./measure";
import { renderGraph, type FoldAction } from "./graph";
import { linearSegments, projectFolds, segmentNodes, type FoldProjection, type LinearSegment } from "./graphFoldModel";
import { layoutGraph, type CommitGraph } from "./graphModel";
import { absoluteTime, accentOf, moveSelection, relativeTime, separateAdjacentAccents, visibleRange } from "./view";

/** How a row was selected: a click (with Ctrl/⌘ or Shift), a key, or a right-click. */
export type Gesture = { kind: "click"; ctrl: boolean; shift: boolean } | { kind: "arrow"; shift: boolean } | { kind: "context" };

export interface ListProps {
  rows: readonly Commit[];
  repoNames: ReadonlyMap<string, string>;
  /** Preferred repository hues, shared with the repository pane. */
  accents: ReadonlyMap<string, number>;
  /** Visible repository-list order, which shares the Log's palette. */
  repoOrder?: readonly string[];
  /** Repositories with commits to pull: their rows' menu offers Pull. */
  behind?: ReadonlySet<string>;
  /** File history: the file's current path, to flag rows where it had another name. */
  historyPath?: string;
  /** The active row (the keyboard's). */
  selected: number;
  /** Every selected row, as commitKey: several for Combined Changes. */
  selectedKeys: ReadonlySet<string>;
  now: number;
  skeleton: boolean;
  /** View options: bold my commits (each repository's user.email), dim commits HEAD does not reach, a hash column. */
  me?: Readonly<Record<string, string>>;
  highlightMine?: boolean;
  offHead?: ReadonlySet<string>;
  hashColumn?: boolean;
}

const SKELETON_ROWS = 8;


/**
 * Virtualized commit grid. Only visible rows exist in the DOM. The grid is one
 * tab stop; the selected row is exposed through aria-activedescendant because
 * recycled rows cannot hold focus themselves.
 */
export class CommitList {
  private rowHeight = 0;
  private frame = 0;
  /** The repo column's width, read once per layout change rather than on every scroll paint. */
  private column: number | undefined;
  private graph: CommitGraph = { rows: [], columns: 0 };
  private graphWidth = 32;
  private accents: ReadonlyMap<string, number> = new Map();
  private segments: LinearSegment[] = [];
  private readonly collapsed = new Set<string>();
  private nodeSegments = new Map<number, string>();
  private edgeActions = new Map<string, FoldAction>();
  private display: FoldProjection = { rows: [], sourceToDisplay: new Map(), hiddenCount: 0 };
  /**
   * Rows in the DOM by display index. A scroll keeps the ones still in range and builds only
   * the rows scrolled into view; anything else (new props, folds, a resize) rebuilds them all.
   * `top`: built as the first visible row, which prints its repository name mid-band.
   */
  private readonly mounted = new Map<number, { el: HTMLElement; top: boolean }>();
  private props: ListProps = { rows: [], repoNames: new Map(), accents: new Map(), historyPath: undefined, selected: -1, selectedKeys: new Set(), now: 0, skeleton: false };

  constructor(
    private readonly root: HTMLElement,
    private readonly body: HTMLElement,
    private readonly onSelect: (index: number, how: Gesture) => void,
    private readonly onOpen: () => void,
    private readonly onFoldStats: (stats: { available: number; collapsed: number; hidden: number }) => void = () => undefined,
    private readonly onAccents: (accents: ReadonlyMap<string, number>) => void = () => undefined,
  ) {
    // Ctrl/⌘ and Shift select several commits (Combined Changes).
    root.setAttribute("aria-multiselectable", "true");
    // Several scroll events can arrive per frame: paint once, before the frame.
    root.addEventListener("scroll", () => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.paint(true);
      });
    }, { passive: true });
    window.addEventListener("resize", () => {
      this.rowHeight = 0;
      this.column = undefined;
      this.paint();
    });
    // Dragging a divider narrows the Log without a window resize: re-fit the repo names.
    new ResizeObserver(() => {
      this.column = undefined;
      this.paint();
    }).observe(root);
    root.addEventListener("keydown", (e) => this.onKey(e));
    body.addEventListener("click", (e) => {
      const fold = (e.target as Element).closest<HTMLElement>("[data-fold-collapse], [data-fold-expand]");
      if (fold && (!(e.ctrlKey || e.metaKey || e.shiftKey) || fold.closest(".folded-row"))) {
        e.preventDefault(); root.focus();
        this.setFold(fold.getAttribute("data-fold-collapse") ?? fold.getAttribute("data-fold-expand")!, fold.hasAttribute("data-fold-collapse"));
        return;
      }
      const row = (e.target as Element).closest<HTMLElement>(".row[data-index]");
      if (!row) return;
      root.focus();
      this.onSelect(Number(row.dataset.index), { kind: "click", ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    });
    // A right-click outside the selection selects that row first, as VS Code's lists do.
    body.addEventListener("contextmenu", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".row[data-index]");
      if (row) this.onSelect(Number(row.dataset.index), { kind: "context" });
    });
  }

  update(next: ListProps): void {
    const moved = next.selected !== this.props.selected;
    if (next.accents !== this.props.accents) this.accents = next.accents;
    let changed = next.rows !== this.props.rows || next.accents !== this.props.accents || next.historyPath !== this.props.historyPath || next.repoOrder !== this.props.repoOrder;
    if (next.rows !== this.props.rows || next.historyPath !== this.props.historyPath) {
      this.segments = next.historyPath ? [] : linearSegments(next.rows);
      this.nodeSegments = segmentNodes(next.rows, this.segments);
      const available = new Set(this.segments.map((segment) => segment.id));
      for (const id of this.collapsed) if (!available.has(id)) this.collapsed.delete(id);
    }
    this.props = next;
    this.root.classList.toggle("hash-column", next.hashColumn === true);
    // A host-driven selection (or a refresh) can reveal a previously hidden commit.
    for (const segment of this.segments) if (this.collapsed.has(segment.id) && segment.hidden.some((i) => next.selectedKeys.has(commitKey(next.rows[i])))) {
      this.collapsed.delete(segment.id); changed = true;
    }
    if (changed) this.rebuild();
    this.column = undefined; // the repo column may have changed with the repo list
    if (moved && next.selected >= 0) this.scrollToIndex(next.selected);
    this.paint();
  }

  resetScroll(): void {
    this.root.scrollTop = 0;
  }

  /** Combined Changes uses the visible order, never commits hidden in a folded path. */
  visibleCommitIndexes(): number[] { return this.display.rows.filter((row) => !row.segment).map((row) => row.sourceIndex); }

  collapseAll(): void { this.changeFolds(new Set(this.segments.map((segment) => segment.id))); }
  expandAll(): void { this.changeFolds(new Set()); }

  private setFold(id: string, collapsed: boolean): void {
    if (!this.segments.some((segment) => segment.id === id)) return;
    const next = new Set(this.collapsed);
    if (collapsed) next.add(id); else next.delete(id);
    this.changeFolds(next);
  }

  private changeFolds(next: ReadonlySet<string>): void {
    const first = Math.floor(this.root.scrollTop / this.height());
    const anchor = this.display.rows[first]?.sourceIndex;
    const offset = this.root.scrollTop - first * this.height();
    this.collapsed.clear(); for (const id of next) this.collapsed.add(id);
    this.rebuild();
    if (anchor !== undefined) {
      let row = this.display.sourceToDisplay.get(anchor);
      if (row === undefined) row = this.display.rows.findIndex((item) => item.segment?.hidden.includes(anchor));
      if (row !== undefined && row >= 0) this.root.scrollTop = row * this.height() + offset;
    }
    const selected = this.segments.find((segment) => this.collapsed.has(segment.id) && segment.hidden.some((i) => this.props.selectedKeys.has(commitKey(this.props.rows[i]))));
    if (selected) { this.onSelect(selected.top, { kind: "click", ctrl: false, shift: false }); return; }
    this.paint();
  }

  private rebuild(): void {
    this.display = projectFolds(this.props.rows, this.segments, this.collapsed);
    const commits = this.display.rows.map((row) => row.commit);
    const accents = separateAdjacentAccents(commits, this.accents, this.props.repoOrder);
    if (accents !== this.accents) { this.accents = accents; this.onAccents(accents); }
    this.graph = layoutGraph(commits, this.accents);
    this.edgeActions = new Map();
    for (const segment of this.segments) if (!this.collapsed.has(segment.id)) {
      const action = { id: segment.id, count: segment.hidden.length };
      for (const i of segment.hidden) this.edgeActions.set(commitKey(this.props.rows[i]), action);
    }
    this.onFoldStats({ available: this.segments.length, collapsed: this.collapsed.size, hidden: this.display.hiddenCount });
  }

  private height(): number {
    if (this.rowHeight === 0) {
      const probe = h("div", { class: "row" }, [h("span", { class: "subject" }, ["M"])]);
      probe.style.visibility = "hidden";
      this.body.append(probe);
      this.rowHeight = probe.getBoundingClientRect().height || 40;
      probe.remove();
    }
    return this.rowHeight;
  }

  private place(el: HTMLElement, i: number): HTMLElement {
    el.style.transform = `translateY(${i * this.height()}px)`;
    return el;
  }

  /** scrolled: only the scroll position changed since the last paint, so built rows stay. */
  private paint(scrolled = false): void {
    const { rows, selected, skeleton } = this.props;
    const rh = this.height();
    if (!scrolled || skeleton) {
      this.graphWidth = Math.max(28, Math.min(12 + Math.max(0, this.graph.columns - 1) * 16, this.root.clientWidth * 0.24));
      this.root.style.setProperty("--graph-width", `${this.graphWidth}px`);
      this.mounted.clear();
      clear(this.body);
    }
    this.root.setAttribute("aria-busy", String(skeleton));
    if (skeleton) {
      this.body.style.height = `${SKELETON_ROWS * rh}px`;
      for (let i = 0; i < SKELETON_ROWS; i++) {
        this.body.append(this.place(h("div", { class: "row skeleton", "aria-hidden": "true" }, [
          h("span", { class: "bar short" }), h("span"), h("span", { class: "bar" }), h("span", { class: "bar short" }), h("span", { class: "bar short" }),
        ]), i));
      }
      this.root.setAttribute("aria-rowcount", "0");
      this.root.removeAttribute("aria-activedescendant");
      return;
    }
    this.body.style.height = `${this.display.rows.length * rh}px`;
    this.root.setAttribute("aria-rowcount", String(this.display.rows.length));
    const { start, end } = visibleRange(this.root.scrollTop, this.root.clientHeight, rh, this.display.rows.length);
    const top = Math.floor(this.root.scrollTop / rh);
    for (const [i, m] of this.mounted) {
      if (i >= start && i < end && m.top === (i === top)) continue;
      m.el.remove();
      this.mounted.delete(i);
    }
    // In display order, so a screen reader walks the rows as they appear.
    const built: HTMLElement[] = [];
    let previous: HTMLElement | undefined;
    for (let i = start; i < end; i++) {
      const kept = this.mounted.get(i);
      if (kept) { previous = kept.el; continue; }
      const row = this.display.rows[i];
      const el = this.place(row.segment ? this.renderFold(i, row.segment) : this.renderRow(rows[row.sourceIndex], row.sourceIndex, i), i);
      if (previous) previous.after(el); else this.body.prepend(el);
      previous = el;
      this.mounted.set(i, { el, top: i === top });
      built.push(el);
    }
    this.fitChips(built);
    this.fitReferences(built);
    if (selected >= 0 && selected < rows.length) this.root.setAttribute("aria-activedescendant", `row-${selected}`);
    else this.root.removeAttribute("aria-activedescendant");
  }

  /**
   * A repo name longer than its column is cut in the middle, to exactly what fits: repos
   * that share a prefix differ at the end, and the browser's own ellipsis would hide it.
   * The full name stays in the chip's tooltip and accessible name.
   */
  private fitChips(rows: readonly HTMLElement[]): void {
    const first = rows[0];
    if (!first) return;
    const column = (this.column ??= parseFloat(getComputedStyle(first).gridTemplateColumns.split(" ")[0]));
    if (!Number.isFinite(column)) {
      this.column = undefined;
      return;
    }
    const chips = rows.flatMap((row) => [...row.querySelectorAll<HTMLElement>(".chip")]);
    if (chips.length === 0) return;
    // Every chip shares one font and padding: read them once, then only write.
    const { font, paddingX } = textStyle(chips[0]);
    for (const chip of chips) chip.textContent = fitName(font, chip.dataset.name ?? "", column - paddingX);
  }

  /** Keep whole reference badges; summarize overflow instead of clipping the last branch. */
  private fitReferences(rows: readonly HTMLElement[]): void {
    const groups = rows.flatMap((row) => [...row.querySelectorAll<HTMLElement>(".row-refs")]).map((group) => {
      const badges = [...group.querySelectorAll<HTMLElement>(".row-ref")];
      const more = group.querySelector<HTMLElement>(".row-ref-more")!;
      return { badges, more, width: group.getBoundingClientRect().width,
        widths: badges.map((badge) => badge.getBoundingClientRect().width),
        moreWidth: more.getBoundingClientRect().width, gap: parseFloat(getComputedStyle(group).columnGap) || 0 };
    });
    for (const { badges, more, width, widths, moreWidth, gap } of groups) {
      if (widths.reduce((sum, size) => sum + size, 0) + gap * (badges.length - 1) <= width) {
        more.hidden = true;
        continue;
      }
      let shown = 0, used = 0;
      while (shown < badges.length - 1 && used + widths[shown] + gap * shown + gap + moreWidth <= width) {
        used += widths[shown++];
      }
      // If even the first name is too long, keep it with an ellipsis beside the count.
      if (shown === 0 && width >= moreWidth + gap + 40) {
        shown = 1;
        badges[0].style.maxWidth = `${width - moreWidth - gap}px`;
      }
      for (const badge of badges.slice(shown)) badge.hidden = true;
      more.textContent = `+${badges.length - shown}`;
    }
  }

  /** One line: repository band | commit graph | subject | author | date. */
  private renderRow(c: Commit, i: number, displayIndex: number): HTMLElement {
    const accent = accentOf(this.accents, c.repoId);
    const name = this.props.repoNames.get(c.repoId) ?? c.repoId;
    const references = referenceLabels(c.refs ?? []), referenceTitle = c.refs?.map((ref) => ref.name).join(", ") ?? "";
    const focus = i === this.props.selected;
    const myEmail = this.props.highlightMine ? this.props.me?.[c.repoId] : undefined;
    const mine = !!myEmail && myEmail.toLowerCase() === c.email.toLowerCase();
    const offHead = this.props.offHead?.has(commitKey(c)) === true;
    const start = this.display.rows[displayIndex - 1]?.commit.repoId !== c.repoId;
    const end = this.display.rows[displayIndex + 1]?.commit.repoId !== c.repoId;
    const showName = start || displayIndex === Math.floor(this.root.scrollTop / this.height());
    const segmentId = this.nodeSegments.get(i), segment = this.segments.find((s) => s.id === segmentId);
    return h("div", {
      class: `row${focus ? " focus" : ""}${mine ? " mine" : ""}${offHead ? " off-head" : ""}`,
      role: "row",
      id: `row-${i}`,
      "aria-rowindex": String(displayIndex + 1),
      "aria-selected": String(this.props.selectedKeys.has(commitKey(c))),
      "data-index": String(i),
      // Right-click: the commit's and its repository's menu (package.json webview/context), not
      // Cut/Copy/Paste. File History is one file of one repository: no repo filter items there.
      // head: the checked-out commit, which alone offers Undo Commit and Edit Commit Message.
      "data-vscode-context": JSON.stringify({ webviewSection: this.props.historyPath ? "historyCommit" : "commit", repoId: c.repoId, sha: c.sha, behind: this.props.behind?.has(c.repoId) === true,
        head: c.refs?.some((ref) => ref.kind === "head") === true, preventDefaultContextMenuItems: true }),
    }, [
      h("span", { class: `repo-band accent-${accent}${start ? " band-start" : ""}${end ? " band-end" : ""}`, role: "gridcell", title: c.ref ? `${name} — ${c.ref}` : name, "aria-label": c.ref ? `${name} — ${c.ref}` : name },
        showName ? [h("span", { class: "chip repo-label", "data-name": name }, [name])] : []),
      renderGraph(this.graph.rows[displayIndex], c, this.graph.columns, this.graphWidth, this.height(), {
        node: segment ? { id: segment.id, count: segment.hidden.length, expand: this.collapsed.has(segment.id) } : undefined, edges: this.edgeActions,
      }),
      h("span", { class: "commit-message", role: "gridcell" }, [
        h("span", { class: "subject", title: c.subject }, [c.subject,
          this.props.historyPath && c.file && c.file.path !== this.props.historyPath ? h("span", { class: "was-path" }, [` — ${c.file.path}`]) : null]),
        references.length ? h("span", { class: "row-refs", title: referenceTitle }, references.map((ref) => {
          const badge = h("span", { class: `row-ref ref-${ref.kinds.at(-1)}`, title: ref.title });
          const marks = h("span", { class: "row-ref-icons" });
          for (const kind of ref.kinds) {
            marks.append(h("span", { class: `row-ref-icon ref-${kind}`, "aria-hidden": "true" }, [codiconElement("tag")]));
          }
          badge.append(marks, h("span", { class: "row-ref-label" }, [ref.label]));
          return badge;
        }).concat(h("span", { class: "row-ref-more", title: referenceTitle,
          "aria-label": `${localize("Commit references")}: ${referenceTitle}` }, [`+${references.length}`]))) : null,
      ]),
      this.props.hashColumn ? h("span", { class: "hash", role: "gridcell", title: c.sha }, [c.sha.slice(0, 8)]) : null,
      h("span", { class: "author", role: "gridcell" }, [c.author]),
      h("span", { class: "date", role: "gridcell", title: absoluteTime(c.time) }, [relativeTime(this.props.now, c.time)]),
    ]);
  }

  private renderFold(index: number, segment: LinearSegment): HTMLElement {
    const c = this.display.rows[index].commit, name = this.props.repoNames.get(c.repoId) ?? c.repoId;
    const start = this.display.rows[index - 1]?.commit.repoId !== c.repoId;
    const end = this.display.rows[index + 1]?.commit.repoId !== c.repoId;
    return h("div", { class: "row folded-row", role: "row", "aria-rowindex": String(index + 1), "aria-selected": "false",
      "data-vscode-context": JSON.stringify({ webviewSection: "graphFold", preventDefaultContextMenuItems: true }) }, [
      h("span", { class: `repo-band accent-${accentOf(this.accents, c.repoId)}${start ? " band-start" : ""}${end ? " band-end" : ""}`, role: "gridcell", "aria-label": name, title: name },
        start ? [h("span", { class: "chip repo-label", "data-name": name }, [name])] : []),
      renderGraph(this.graph.rows[index], c, this.graph.columns, this.graphWidth, this.height(), { folded: { id: segment.id, count: segment.hidden.length }, edges: this.edgeActions }),
      h("span", { role: "gridcell", class: "fold-summary" }, [h("button", { type: "button", class: "fold-expand", "data-fold-expand": segment.id,
        title: localize("Expand {0} hidden commits", segment.hidden.length), "aria-expanded": "false" }, [localize("{0} commits hidden · Expand", segment.hidden.length)])]),
      this.props.hashColumn ? h("span", { role: "gridcell", class: "hash" }) : null,
      h("span", { role: "gridcell", class: "author" }), h("span", { role: "gridcell", class: "date" }),
    ]);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target !== this.root) return;
    if (!e.ctrlKey && !e.metaKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const id = this.nodeSegments.get(this.props.selected);
      if (id) { e.preventDefault(); this.setFold(id, e.key === "ArrowLeft"); }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.onOpen();
      return;
    }
    const page = Math.max(1, Math.floor(this.root.clientHeight / this.height()) - 1);
    const order = this.visibleCommitIndexes();
    const next = moveSelection(e.key, order.indexOf(this.props.selected), order.length, page);
    if (next === null) return;
    e.preventDefault();
    this.onSelect(order[next], { kind: "arrow", shift: e.shiftKey });
  }

  private scrollToIndex(i: number): void {
    const rh = this.height();
    const displayIndex = this.display.sourceToDisplay.get(i);
    if (displayIndex === undefined) return;
    const top = displayIndex * rh;
    if (top < this.root.scrollTop) this.root.scrollTop = top;
    else if (top + rh > this.root.scrollTop + this.root.clientHeight) this.root.scrollTop = top + rh - this.root.clientHeight;
  }
}
