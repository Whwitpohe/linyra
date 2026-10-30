import { commitKey, type Commit } from "../types";
import { localize } from "../i18n";
import { isMine, whenLabel } from "../hoverModel";
import { clear, h } from "./dom";
import type { HoverRow } from "./hoverCard";
import { commitPills, rowRefs, type Upstream } from "./refPills";
import { chWidth, fitName, textStyle } from "./measure";
import { graphWidthFor, hoverRail, railAt, renderGraph, type FoldAction, type RailAction } from "./graph";
import { historyChangeCell, historySubjectNotes } from "./history";
import { linearSegments, projectFolds, segmentNodes, type FoldProjection, type LinearSegment } from "./graphFoldModel";
import { indexParents, layoutGraph, type CommitGraph, type ParentIndex } from "./graphModel";
import { absoluteTime, accentOf, relativeTime, repoColumnChars, separateAdjacentAccents, visibleRange } from "./view";
import { DEFAULT_COLUMNS, layoutColumns, type ColumnId, type ColumnLayout, type ColumnPrefs, type SizedColumn } from "./logColumns";
import { avatarKey } from "./ui/authorDisc";
import type { ChangesMode } from "../changeStats";
import type { ChangesStage } from "./changeViz";
import { changesCell, statsFor, statsKeyOf } from "./changesColumn";
import { moveWithWork, summaryKey, type WorkSummary } from "./workSummary";
import { workContext, workRowCells, workRowLabel } from "./workRow";

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
  /** Each repository's distance from its upstream: the checked-out branch's pill shows it. */
  upstream?: Upstream;
  /** The Changes column's drawing (the column header); none: no column. Not in File History, which has its own. */
  changes?: Exclude<ChangesMode, "off">;
  /** The column header's widths, hidden columns and date format. */
  columns?: ColumnPrefs;
  /** The summary row of uncommitted work above the newest commit (workSummary.ts); none: no row. */
  work?: WorkSummary | null;
  /** The summary row is the selection (the Changes view shows its work); `selected` is then -1. */
  workSelected?: boolean;
  /** Whose work the Changes view shows (a chip in the row); undefined: the most recently edited. */
  workRepo?: string;
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
  /** The timer that ends a scroll (the root's .scrolling class); 0 while still. */
  private scrolling: ReturnType<typeof setTimeout> | 0 = 0;
  /** The repo names' font, insets and ch width, read once per layout change rather than on every paint. */
  private column: { font: string; paddingX: number; rowPaddingX: number; ch: number } | undefined;
  /** The list's width at the last full paint (read before it builds rows, so no early layout). */
  private listWidth = 0;
  /** How much the Changes column draws at this width (changesColumn.ts). */
  private changesStage: ChangesStage = "mini";
  private chars = 0;
  private charsOf: ReadonlyMap<string, string> | undefined;
  /**
   * The references cell's room and gap, and each pill's width by its look and text, read once per
   * layout change: every row draws the same few pills (develop | origin, a tag), and reading one
   * forces the frame's layout early. A scroll through pills already seen reads nothing.
   */
  private refRoom: { width: number; gap: number } | undefined;
  private readonly refWidths = new Map<string, number>();
  private graph: CommitGraph = { rows: [], columns: 0 };
  /** Each row's parents as row indexes, extended page by page instead of rebuilt (fold segments and the graph share it). */
  private parents: ParentIndex | undefined;
  private graphWidth = 32;
  private accents: ReadonlyMap<string, number> = new Map();
  private segments: LinearSegment[] = [];
  /** The same segments by id: a row finds its own without walking every segment of the history. */
  private segmentById = new Map<string, LinearSegment>();
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
  /** A branch pill was clicked: show that branch in the Repo List (main.ts). */
  onRevealBranch: (repoId: string, ref: string) => void = () => undefined;
  /**
   * The summary row of uncommitted work, between the column header and the rows: it scrolls with
   * them, one row high (lead()), and the rows' positions are counted after it.
   */
  private readonly workEl = h("div", { class: "work-summary", role: "row", id: "row-work", hidden: true });
  /** What the summary row was last built from (renderWork). */
  private workKey = "";
  /** The summary row was chosen (a click, a repository's chip, ↑ from the newest commit): main.ts shows its work. */
  onWork: (repoId?: string) => void = () => undefined;
  /** Its Commit… button: the Commit side bar, for that repository alone when there is one. */
  onCommitWork: (repoId?: string) => void = () => undefined;
  /** The branch whose sheet is open: its pills are marked wherever its rows are drawn. */
  private openBranch: { repoId: string; ref: string } | undefined;
  /** The columns (logColumns.ts), worked out at each full paint; the column header draws them too. */
  private layout: ColumnLayout | undefined;
  private shown = new Set<ColumnId>();
  /** The rows' font `ch` and side padding, read once per layout change. */
  private metrics: { ch: number; padX: number } | undefined;
  /** The sticky column header's height: the rows start under it. */
  private headerHeight: number | undefined;
  /** The columns were worked out (main.ts draws the column header from them). */
  onLayout: (layout: ColumnLayout) => void = () => undefined;
  /**
   * The list's scrollTop as last read or written, and its height (-1: read it once after a resize).
   * Reading either after a DOM write lays the page out early: holding ↓ laid it out twice a frame.
   */
  private top = 0;
  private viewport = -1;
  /** A scrollTop this list set, whose scroll event is still to come (forgotten at the next frame if none comes). */
  private expected: number | undefined;
  /** A position set while the list was hidden, so never written: placed when it shows (resized()). */
  private unplaced = false;
  /** The scroll position the rows being built go by (renderRow: which row prints its repository's name). */
  private paintTop = 0;

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
    // Several scroll events can arrive per frame: paint once, before the frame. A scroll this list
    // started has its position known; any other (the wheel, the scrollbar) is read here, once.
    root.addEventListener("scroll", () => {
      if (this.expected !== undefined) { this.top = this.expected; this.expected = undefined; } else this.top = root.scrollTop;
      // Rows moving under a still pointer do not answer it until the scrolling stops: one hover
      // per frame (a row's tint, its disc growing, its buttons moving in) would cost a layout each.
      if (!this.scrolling) root.classList.add("scrolling");
      clearTimeout(this.scrolling);
      this.scrolling = setTimeout(() => { this.scrolling = 0; root.classList.remove("scrolling"); }, 150);
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.paint(true);
      });
    }, { passive: true });
    window.addEventListener("resize", () => {
      this.rowHeight = 0;
      this.resized();
    });
    // Dragging a divider narrows the Log without a window resize: re-fit the repo names. Hiding
    // and showing it (another view in its place) resizes it too.
    new ResizeObserver(() => this.resized()).observe(root);
    // VS Code sets the theme's variables (the font, its size) on <html>: a change there resizes the text.
    new MutationObserver(() => {
      this.forgetLayout();
      this.paint();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    // Avatars arrive in batches after the rows that show their discs: AvatarFeed (avatars.ts) calls redraw() once per batch.
    root.addEventListener("keydown", (e) => this.onKey(e));
    body.addEventListener("click", (e) => {
      const fold = (e.target as Element).closest<HTMLElement>("[data-fold-collapse], [data-fold-expand]");
      if (fold && (!(e.ctrlKey || e.metaKey || e.shiftKey) || fold.closest(".folded-row"))) {
        e.preventDefault(); root.focus();
        this.setFold(fold.getAttribute("data-fold-collapse") ?? fold.getAttribute("data-fold-expand")!, fold.hasAttribute("data-fold-collapse"));
        return;
      }
      // A rail into linear history folds it (found by position: a row draws its rails as a few paths).
      const graph = (e.target as Element).closest(".commit-graph");
      const rail = graph && !(e.ctrlKey || e.metaKey || e.shiftKey) ? railAt(graph, e.clientX, e.clientY) : undefined;
      if (rail) {
        e.preventDefault(); root.focus();
        this.setFold(rail.action.id, true);
        return;
      }
      const row = (e.target as Element).closest<HTMLElement>(".row[data-index]");
      if (!row) return;
      root.focus();
      this.onSelect(Number(row.dataset.index), { kind: "click", ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
      // A plain click on a branch pill also shows that branch, the part's own (where: main.ts's onRevealBranch).
      const pill = (e.target as Element).closest<HTMLElement>(".row-ref .pill-part[data-ref], .row-ref[data-ref]");
      if (pill?.dataset.repo && pill.dataset.ref && !(e.ctrlKey || e.metaKey || e.shiftKey)) this.onRevealBranch(pill.dataset.repo, pill.dataset.ref);
    });
    // The rail under the pointer is highlighted and says that a click folds it.
    let hovered: { graph: Element; rail: RailAction | undefined } | undefined;
    const hover = (graph: Element | undefined, rail: RailAction | undefined) => {
      if (hovered?.graph === graph && hovered?.rail === rail) return;
      if (hovered && hovered.graph !== graph) hoverRail(hovered.graph, undefined);
      if (graph) hoverRail(graph, rail);
      hovered = graph ? { graph, rail } : undefined;
    };
    body.addEventListener("pointermove", (e) => {
      const graph = (e.target as Element).closest(".commit-graph") ?? undefined;
      hover(graph, graph ? railAt(graph, e.clientX, e.clientY) : undefined);
    });
    body.addEventListener("pointerleave", () => hover(undefined, undefined));
    this.workEl.addEventListener("click", (e) => {
      const t = e.target as Element, work = this.props.work;
      if (!work) return;
      root.focus();
      if (t.closest(".summary-commit")) { this.onCommitWork(work.repos.length === 1 ? work.repos[0].repoId : undefined); return; }
      this.onWork(t.closest<HTMLElement>("[data-work-repo]")?.dataset.workRepo);
    });
    // A right-click outside the selection selects that row first, as VS Code's lists do.
    body.addEventListener("contextmenu", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".row[data-index]");
      if (row) this.onSelect(Number(row.dataset.index), { kind: "context" });
    });
  }

  update(next: ListProps): void {
    const prev = this.props;
    const moved = next.selected !== prev.selected;
    if (next.accents !== prev.accents) this.accents = next.accents;
    let changed = next.rows !== prev.rows || next.accents !== prev.accents || next.historyPath !== prev.historyPath || next.repoOrder !== prev.repoOrder;
    if (next.rows !== this.props.rows || next.historyPath !== this.props.historyPath) {
      this.parents = indexParents(next.rows, this.parents);
      this.segments = next.historyPath ? [] : linearSegments(next.rows, this.parents);
      this.segmentById = new Map(this.segments.map((segment) => [segment.id, segment]));
      this.nodeSegments = segmentNodes(next.rows, this.segments);
      const available = new Set(this.segments.map((segment) => segment.id));
      for (const id of this.collapsed) if (!available.has(id)) this.collapsed.delete(id);
    }
    const hadWork = this.lead() > 0;
    this.props = next;
    this.root.classList.toggle("hash-column", next.hashColumn === true);
    // The summary row came or went: the commits move one row; a scrolled list keeps them where they were.
    const leadChanged = hadWork !== this.lead() > 0;
    if (leadChanged && this.top > 0) this.setTop(this.top + (hadWork ? -1 : 1) * this.height());
    // A host-driven selection (or a refresh) can reveal a previously hidden commit.
    for (const segment of this.segments) if (this.collapsed.has(segment.id) && segment.hidden.some((i) => next.selectedKeys.has(commitKey(next.rows[i])))) {
      this.collapsed.delete(segment.id); changed = true;
    }
    if (changed) this.rebuild();
    // Anything else the host sends (uncommitted counts, a toolbar state) re-renders the page with
    // the same rows: those are left as they are, and a new selection only marks the rows it moved
    // between. Rebuilding every visible row for each such message made scrolling stutter.
    const drawn = changed || next.repoNames !== prev.repoNames || next.behind !== prev.behind || next.me !== prev.me || next.highlightMine !== prev.highlightMine
      || next.offHead !== prev.offHead || next.hashColumn !== prev.hashColumn || next.now !== prev.now || next.skeleton !== prev.skeleton
      || next.upstream !== prev.upstream || next.changes !== prev.changes || next.columns !== prev.columns || leadChanged;
    if (moved && next.selected >= 0) this.scrollToIndex(next.selected);
    if (drawn) this.paint();
    else if (moved || next.selectedKeys !== prev.selectedKeys || next.workSelected !== prev.workSelected) { this.paintSelection(); this.paint(true); }
    if (!drawn) this.renderWork();
  }

  /**
   * The branch sheet opened for this branch (main.ts): its pills are marked, so the sheet's branch
   * is seen in the Log. No argument: the sheet closed.
   */
  markBranch(repoId?: string, ref?: string): void {
    this.openBranch = repoId && ref ? { repoId, ref } : undefined;
    for (const { el } of this.mounted.values()) this.markPills(el);
  }

  private markPills(row: HTMLElement): void {
    const open = this.openBranch;
    // The part that names the branch: develop in "develop | origin", origin in it for origin/develop.
    for (const part of row.querySelectorAll<HTMLElement>(".row-ref .pill-part[data-ref]")) {
      // aria-current: an attribute, so fitReferences's widths (cached by class and text) still hold.
      if (open && part.dataset.repo === open.repoId && part.dataset.ref === open.ref) part.setAttribute("aria-current", "true");
      else part.removeAttribute("aria-current");
    }
  }

  /** The mounted rows' selected and focused marks, as renderRow sets them. */
  private paintSelection(): void {
    const { rows, selected, selectedKeys } = this.props;
    for (const [i, { el }] of this.mounted) {
      const row = this.display.rows[i];
      if (!row || row.segment) continue;
      el.classList.toggle("focus", row.sourceIndex === selected);
      el.setAttribute("aria-selected", String(selectedKeys.has(commitKey(rows[row.sourceIndex]))));
    }
  }

  resetScroll(): void {
    this.setTop(0);
  }

  /** Scrolls to `value` (kept within the list), remembering it: the scroll event will not read it back. */
  private setTop(value: number): void {
    const room = this.clientHeight();
    const max = Math.max(0, (this.headerHeight ?? 0) + this.lead() + this.display.rows.length * this.height() - room);
    const next = Math.max(0, Math.min(max, value));
    if (next === this.top && !this.unplaced) return;
    this.top = next;
    // Hidden: nothing scrolls and no event comes. The position is placed when the list shows.
    this.unplaced = room === 0;
    if (this.unplaced) return;
    // The rows' height first: the browser would hold the position to the shorter list it last laid out.
    if (!this.props.skeleton) this.fitBody(this.display.rows.length * this.height());
    this.expected = next;
    this.root.scrollTop = next;
    // A position the list already had sends no event: what was expected is not kept past this frame
    // (the frame's scroll events come before its animation frames).
    requestAnimationFrame(() => { this.expected = undefined; });
  }

  /** The rows' full height, which the list scrolls over: written only when it changes. */
  private fitBody(px: number): void {
    const height = `${px}px`;
    if (this.body.style.height !== height) this.body.style.height = height;
  }

  /**
   * The list was resized, hidden or shown: what was measured may no longer hold, and the position
   * the list last set is placed again where the page does not have it (one set while hidden never
   * reached the page; a hidden list shows again at the top).
   */
  private resized(): void {
    this.forgetLayout();
    const actual = this.root.scrollTop;
    if (actual !== this.top || this.unplaced) {
      const wanted = this.top;
      this.top = actual;
      this.expected = undefined;
      this.unplaced = false;
      // The header counts in how far the list scrolls (setTop's bottom), read before it is used.
      this.headerHeight = this.root.querySelector<HTMLElement>(".column-header")?.offsetHeight ?? 0;
      this.setTop(wanted);
    }
    this.paint();
  }

  private clientHeight(): number {
    if (this.viewport < 0) this.viewport = this.root.clientHeight;
    return this.viewport;
  }

  /** The rows on screen built again from the same props: new avatars arrived (avatars.ts), once per batch. */
  redraw(changed?: ReadonlySet<string>): void {
    if (!changed) { this.paint(); return; }
    // Only the rows whose author's avatar arrived, and only where the graph draws that author's disc
    // (a dense graph draws dots, which show no avatar): the rest of the screen stays as it is.
    let dropped = false;
    for (const [i, m] of this.mounted) {
      const c = this.display.rows[i]?.commit;
      if (!c || !changed.has(avatarKey(c.email)) || !m.el.querySelector(".author-disc")) continue;
      m.el.remove();
      this.mounted.delete(i);
      dropped = true;
    }
    if (dropped) this.paint(true);
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
    // Counted after the summary row; scrolled no further than it, the list stays where it is.
    const lead = this.lead(), below = this.top >= lead;
    const first = Math.floor(this.rowTop() / this.height());
    const anchor = below ? this.display.rows[first]?.sourceIndex : undefined;
    const offset = this.rowTop() - first * this.height();
    this.collapsed.clear(); for (const id of next) this.collapsed.add(id);
    this.rebuild();
    if (anchor !== undefined) {
      let row = this.display.sourceToDisplay.get(anchor);
      if (row === undefined) row = this.display.rows.findIndex((item) => item.segment?.hidden.includes(anchor));
      if (row !== undefined && row >= 0) this.setTop(lead + row * this.height() + offset);
    }
    // The rows are drawn anew first: the selection's own repaint keeps the rows already built.
    this.paint();
    const selected = this.segments.find((segment) => this.collapsed.has(segment.id) && segment.hidden.some((i) => this.props.selectedKeys.has(commitKey(this.props.rows[i]))));
    if (selected) this.onSelect(selected.top, { kind: "click", ctrl: false, shift: false });
  }

  private rebuild(): void {
    this.display = projectFolds(this.props.rows, this.segments, this.collapsed);
    const commits = this.display.rows.map((row) => row.commit);
    const accents = separateAdjacentAccents(commits, this.accents, this.props.repoOrder);
    if (accents !== this.accents) { this.accents = accents; this.onAccents(accents); }
    // Nothing folded: the shown rows are the loaded ones, whose parent index is current.
    this.graph = layoutGraph(commits, this.accents, this.display.hiddenCount === 0 ? this.parents : undefined);
    this.edgeActions = new Map();
    for (const segment of this.segments) if (!this.collapsed.has(segment.id)) {
      const action = { id: segment.id, count: segment.hidden.length };
      for (const i of segment.hidden) this.edgeActions.set(commitKey(this.props.rows[i]), action);
    }
    this.onFoldStats({ available: this.segments.length, collapsed: this.collapsed.size, hidden: this.display.hiddenCount });
  }

  /** The summary row's height (one row), or 0 without it: the rows start that much lower. */
  private lead(): number {
    return this.props.work && !this.props.skeleton ? this.height() : 0;
  }

  private workRows(): number {
    return this.lead() > 0 ? 1 : 0;
  }

  /** The scroll position over the rows themselves: the list's, less the summary row above them. */
  private rowTop(): number {
    return Math.max(0, this.top - this.lead());
  }

  /** The summary row (workRow.ts), placed right before the rows and built again only when what it draws changes. */
  private renderWork(): void {
    if (this.workEl.nextElementSibling !== this.body) this.body.before(this.workEl);
    const w = this.lead() ? this.props.work! : null;
    const shownRepo = w ? (w.repos.some((r) => r.repoId === this.props.workRepo) ? this.props.workRepo : w.repos[0].repoId) : undefined;
    const names = (id: string) => this.props.repoNames.get(id) ?? id;
    // By the clock now, not the page's: work is edited after the commits were read.
    const when = w?.editedAt != null ? relativeTime(Math.floor(Date.now() / 1000), Math.floor(w.editedAt / 1000)) : "";
    const key = w ? JSON.stringify([summaryKey(w), w.repos.map((r) => [names(r.repoId), accentOf(this.accents, r.repoId), this.props.behind?.has(r.repoId)]),
      shownRepo, [...this.shown], this.graphWidth, this.height(), this.layout?.repoName != null, this.props.changes, this.changesStage, when]) : "";
    const selected = String(this.props.workSelected === true);
    if (this.workEl.getAttribute("aria-selected") !== selected) this.workEl.setAttribute("aria-selected", selected);
    if (key === this.workKey) return;
    this.workKey = key;
    this.workEl.hidden = !w;
    if (!w) { this.workEl.replaceChildren(); return; }
    const options = { summary: w, name: names, accent: (id: string) => accentOf(this.accents, id), shown: this.shown, graphWidth: this.graphWidth,
      rowHeight: this.height(), repoNames: this.layout?.repoName != null, shownRepo, behind: (id: string) => this.props.behind?.has(id) === true,
      changes: this.props.changes ? { mode: this.props.changes, stage: this.changesStage } : undefined, when };
    this.workEl.setAttribute("aria-rowindex", "2");
    this.workEl.setAttribute("aria-label", workRowLabel(options));
    // One repository: its own menu, as on the Uncommitted side; several: each chip has its repository's.
    this.workEl.setAttribute("data-vscode-context", JSON.stringify(w.repos.length === 1 ? workContext(w.repos[0], options.behind(w.repos[0].repoId)) : { preventDefaultContextMenuItems: true }));
    this.workEl.replaceChildren(...workRowCells(options));
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
      // The columns (and the hash column, File History) set the references cell's room.
      this.refRoom = undefined;
      this.listWidth = this.root.clientWidth;
      this.writeColumns(this.columnLayout(this.props.columns ?? DEFAULT_COLUMNS));
      this.onLayout(this.layout!);
      this.renderWork();
      this.mounted.clear();
      clear(this.body);
      // Read once per layout change, with no rows to lay out.
      if (this.headerHeight === undefined) this.headerHeight = this.root.querySelector<HTMLElement>(".column-header")?.offsetHeight ?? 0;
    }
    this.root.setAttribute("aria-busy", String(skeleton));
    if (skeleton) {
      this.fitBody(SKELETON_ROWS * rh);
      for (let i = 0; i < SKELETON_ROWS; i++) {
        this.body.append(this.place(h("div", { class: "row skeleton", "aria-hidden": "true" }, [
          h("span", { class: "bar short" }), h("span"), h("span", { class: "bar" }), h("span", { class: "bar short" }), h("span", { class: "bar short" }),
        ]), i));
      }
      // Loading: how many rows there will be is not known yet.
      this.root.setAttribute("aria-rowcount", "-1");
      this.root.removeAttribute("aria-activedescendant");
      return;
    }
    this.fitBody(this.display.rows.length * rh);
    // The column header is the grid's first row (and the summary row the second): the commits are numbered after them.
    this.root.setAttribute("aria-rowcount", String(this.display.rows.length + 1 + this.workRows()));
    const rowTop = this.rowTop();
    const { start, end } = visibleRange(rowTop, this.viewHeight(), rh, this.display.rows.length);
    const top = Math.floor(rowTop / rh);
    this.paintTop = rowTop;
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
    this.fitNames(built);
    this.fitReferences(built);
    // Rows are built only here: new ones start unmarked.
    if (this.openBranch) for (const el of built) this.markPills(el);
    if (this.props.workSelected && this.workRows()) this.root.setAttribute("aria-activedescendant", "row-work");
    else if (selected >= 0 && selected < rows.length) this.root.setAttribute("aria-activedescendant", `row-${selected}`);
    else this.root.removeAttribute("aria-activedescendant");
  }

  /** The columns as last worked out (the column header draws them). */
  columns(): ColumnLayout | undefined {
    return this.layout;
  }

  /** The rows' height on screen: the list's, less the sticky column header over them. */
  private viewHeight(): number {
    return Math.max(0, this.clientHeight() - (this.headerHeight ?? 0));
  }

  /** The columns at this width for these prefs (logColumns.ts); the rows' font and padding read once per layout change. */
  private columnLayout(prefs: ColumnPrefs): ColumnLayout {
    if (!this.metrics) {
      const s = getComputedStyle(this.root);
      this.metrics = { ch: chWidth(s.font), padX: parseFloat(s.getPropertyValue("--pad-x")) || 12 };
    }
    const { ch, padX } = this.metrics;
    return layoutColumns({
      history: !!this.props.historyPath, width: this.listWidth - 2 * padX, outer: this.listWidth, ch, repoChars: this.repoChars(),
      graphAuto: graphWidthFor(this.graph.columns, this.listWidth * 0.24), hash: this.props.hashColumn === true,
      changes: this.changesShown() ? this.props.changes : undefined, prefs,
    });
  }

  /** One template for the rows, the column header and File History's work row (styles.css --log-columns). */
  private writeColumns(layout: ColumnLayout): void {
    this.layout = layout;
    this.shown = new Set(layout.columns.map((c) => c.id));
    this.graphWidth = layout.graph;
    if (layout.changesStage) this.changesStage = layout.changesStage;
    const pane = this.root.parentElement ?? this.root;
    pane.style.setProperty("--log-columns", layout.template);
    pane.style.setProperty("--log-gap", `${layout.gap}px`);
    pane.classList.toggle("narrow", layout.narrow);
    pane.classList.toggle("tiny", layout.tiny);
    // The repository column without names: its color strip alone (narrow, or the name hidden).
    pane.classList.toggle("repo-strip", layout.repoName === null);
    for (const id of ["hash", "author", "date"] as const) pane.classList.toggle(`hide-${id}`, !this.shown.has(id));
    this.root.classList.toggle("with-changes", this.shown.has("changes"));
    this.root.style.setProperty("--graph-width", `${layout.graph}px`);
  }

  /**
   * A column header's sash being dragged: the columns at that width, written without rebuilding a
   * row or saving it (letting go saves it, and the full paint that follows fits names and pills).
   * undefined: back to the saved widths.
   */
  previewColumn(id: SizedColumn, px: number | undefined): number | undefined {
    if (!this.layout) return undefined;
    const prefs = this.props.columns ?? DEFAULT_COLUMNS;
    const layout = this.columnLayout(px === undefined ? prefs : { ...prefs, widths: { ...prefs.widths, [id]: px } });
    // The graph's rows keep the width they were drawn at until the drag ends.
    const pane = this.root.parentElement ?? this.root;
    pane.style.setProperty("--log-columns", layout.template);
    this.layout = { ...this.layout, columns: layout.columns, template: layout.template };
    return layout.columns.find((c) => c.id === id)?.px ?? undefined;
  }

  /**
   * A repo name longer than its column is cut in the middle, to exactly what fits: repos
   * that share a prefix differ at the end, and the browser's own ellipsis would hide it.
   * The full name stays in the band's tooltip and accessible name.
   */
  private fitNames(rows: readonly HTMLElement[]): void {
    const first = rows[0];
    const width = this.layout?.repoName;
    if (!first || !width) return;
    const labels = rows.flatMap((row) => [...row.querySelectorAll<HTMLElement>(".repo-label")]);
    if (labels.length === 0) return;
    // Every name shares one font and inset: read them once per layout change (a resize, a theme),
    // then only write. The column's width is the column model's, not read from the grid's tracks:
    // that would lay out every row just built, and the names written after it again.
    if (!this.column) {
      const label = textStyle(labels[0]), band = textStyle(labels[0].parentElement!), row = textStyle(first);
      this.column = { font: label.font, paddingX: label.paddingX + band.paddingX, rowPaddingX: row.paddingX, ch: chWidth(label.font) };
    }
    const { font, paddingX } = this.column;
    for (const label of labels) label.textContent = fitName(font, label.dataset.name ?? "", width - paddingX);
  }

  /** The longest repository name in characters (as main.ts sizes --repo-col), per repository list. */
  private repoChars(): number {
    if (this.charsOf !== this.props.repoNames) {
      this.charsOf = this.props.repoNames;
      this.chars = repoColumnChars([...this.props.repoNames.values()]);
    }
    return this.chars;
  }

  /** A resize, a divider drag or new props: what was measured may no longer hold. */
  private forgetLayout(): void {
    this.column = undefined;
    this.viewport = -1;
    this.metrics = undefined;
    this.headerHeight = undefined;
    this.refRoom = undefined;
    this.refWidths.clear();
  }

  /** Keep whole reference badges; summarize overflow instead of clipping the last branch. */
  private fitReferences(rows: readonly HTMLElement[]): void {
    const cells = rows.flatMap((row) => [...row.querySelectorAll<HTMLElement>(".row-refs")]).map((group) => ({
      badges: [...group.querySelectorAll<HTMLElement>(".row-ref")], more: group.querySelector<HTMLElement>(".row-ref-more")!, group }));
    if (cells.length === 0) return;
    const look = (el: HTMLElement) => `${el.className}\0${el.textContent}`;
    // Reads first, all of them, and only what is not known yet: one early layout at most.
    if (!this.refRoom) {
      const group = cells[0].group, style = getComputedStyle(group);
      const cell = group.parentElement!.getBoundingClientRect().width;
      // The cell's max-width (refPills.css / styles.css): a share of the message column.
      const max = style.maxWidth.endsWith("%") ? (cell * parseFloat(style.maxWidth)) / 100 : parseFloat(style.maxWidth) || cell;
      this.refRoom = { width: max, gap: parseFloat(style.columnGap) || 0 };
    }
    for (const el of cells.flatMap((c) => [...c.badges, c.more])) {
      const key = look(el);
      if (!this.refWidths.has(key)) this.refWidths.set(key, el.getBoundingClientRect().width);
    }
    const { width: room, gap } = this.refRoom;
    for (const { badges, more } of cells) {
      const widths = badges.map((badge) => this.refWidths.get(look(badge)) ?? 0), moreWidth = this.refWidths.get(look(more)) ?? 0;
      // What the cell takes before the fit: every pill and the "+N", up to its max-width.
      const width = Math.min(room, widths.reduce((sum, size) => sum + size, 0) + gap * badges.length + moreWidth);
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
    const focus = i === this.props.selected;
    // My commit (the repository's user.email): its graph disc always has the thicker ring;
    // Highlight My Commits also bolds its text.
    const myEmail = this.props.me?.[c.repoId];
    const own = !!myEmail && myEmail.toLowerCase() === c.email.toLowerCase();
    const mine = own && this.props.highlightMine === true;
    const offHead = this.props.offHead?.has(commitKey(c)) === true;
    const start = this.display.rows[displayIndex - 1]?.commit.repoId !== c.repoId;
    const end = this.display.rows[displayIndex + 1]?.commit.repoId !== c.repoId;
    // A name only where the repository column has room for names (a strip in the narrow layout).
    const showName = this.layout?.repoName != null && (start || displayIndex === Math.floor(this.paintTop / this.height()));
    const segmentId = this.nodeSegments.get(i), segment = segmentId === undefined ? undefined : this.segmentById.get(segmentId);
    const ago = relativeTime(this.props.now, c.time);
    return h("div", {
      class: `row${focus ? " focus" : ""}${mine ? " mine" : ""}${offHead ? " off-head" : ""}`,
      role: "row",
      id: `row-${i}`,
      "aria-rowindex": String(displayIndex + 2 + this.workRows()),
      "aria-selected": String(this.props.selectedKeys.has(commitKey(c))),
      "data-index": String(i),
      // Right-click: the commit's and its repository's menu (package.json webview/context), not
      // Cut/Copy/Paste. File History is one file of one repository: no repo filter items there.
      // head: the checked-out commit, which alone offers Undo Commit and Edit Commit Message.
      "data-vscode-context": JSON.stringify({ webviewSection: this.props.historyPath ? "historyCommit" : "commit", repoId: c.repoId, sha: c.sha, behind: this.props.behind?.has(c.repoId) === true,
        head: c.refs?.some((ref) => ref.kind === "head") === true, ...(this.props.historyPath ? { historyFileDeleted: c.file?.status === "D" } : {}), preventDefaultContextMenuItems: true }),
    }, [
      h("span", { class: `repo-band accent-${accent}${start ? " band-start" : ""}${end ? " band-end" : ""}`, role: "gridcell", title: c.ref ? `${name} — ${c.ref}` : name, "aria-label": c.ref ? `${name} — ${c.ref}` : name },
        showName ? [h("span", { class: "repo-label", "data-name": name }, [name])] : []),
      renderGraph(this.graph.rows[displayIndex], c, this.graph.columns, this.graphWidth, this.height(), {
        node: segment ? { id: segment.id, count: segment.hidden.length, expand: this.collapsed.has(segment.id) } : undefined, edges: this.edgeActions,
      }, own),
      // No title tooltips on the subject, node, hash or date: the hover card shows all of it (hoverCard.ts).
      h("span", { class: "commit-message", role: "gridcell" }, [
        h("span", { class: "subject" }, [c.subject, ...(this.props.historyPath ? historySubjectNotes(c.file, this.props.historyPath) : [])]),
        rowRefs(c.repoId, commitPills(c.repoId, c.refs, this.props.upstream)),
      ]),
      // File History: what this commit did to the file (M +12 −3).
      this.props.historyPath ? historyChangeCell(c.file) : null,
      // The columns the column model shows (logColumns.ts): no hidden cell takes a track.
      this.shown.has("hash") ? h("span", { class: "hash", role: "gridcell" }, [c.sha.slice(0, 8)]) : null,
      this.shown.has("author") ? h("span", { class: "author", role: "gridcell" }, [c.author]) : null,
      this.shown.has("changes") ? changesCell(statsFor(c.repoId, c.sha), this.props.changes!, this.changesStage) : null,
      this.shown.has("date") ? h("span", { class: "date", role: "gridcell", "aria-label": whenLabel(this.props.now, c.time, ago) },
        [this.props.columns?.dates === "absolute" ? absoluteTime(c.time) : ago]) : null,
    ]);
  }

  private changesShown(): boolean {
    return this.props.changes !== undefined && !this.props.historyPath;
  }

  /** Stats arrived for these commits (repoId\0sha): their rows on screen get their Changes cell, nothing else is rebuilt. */
  statsArrived(keys: ReadonlySet<string>): void {
    if (!this.changesShown()) return;
    for (const [i, { el }] of this.mounted) {
      const c = this.display.rows[i];
      if (!c || c.segment || !keys.has(statsKeyOf(c.commit.repoId, c.commit.sha))) continue;
      el.querySelector(".changes-cell")?.replaceWith(changesCell(statsFor(c.commit.repoId, c.commit.sha), this.props.changes!, this.changesStage));
    }
  }

  /** The commit at a row's data-index (the hover card asks on every pointer move). */
  commitAt(index: number): Commit | undefined {
    return this.props.rows[index];
  }

  /** What the hover card shows at once for the commit at a row's data-index: the row's own data, no git. */
  hoverRow(index: number): HoverRow | undefined {
    const c = this.props.rows[index];
    if (!c) return undefined;
    return { commit: c, repoName: this.props.repoNames.get(c.repoId) ?? c.repoId, accent: accentOf(this.accents, c.repoId),
      mine: isMine(c.email, this.props.me?.[c.repoId]), pills: commitPills(c.repoId, c.refs, this.props.upstream), now: this.props.now };
  }

  private renderFold(index: number, segment: LinearSegment): HTMLElement {
    const c = this.display.rows[index].commit, name = this.props.repoNames.get(c.repoId) ?? c.repoId;
    const start = this.display.rows[index - 1]?.commit.repoId !== c.repoId;
    const end = this.display.rows[index + 1]?.commit.repoId !== c.repoId;
    return h("div", { class: "row folded-row", role: "row", "aria-rowindex": String(index + 2 + this.workRows()), "aria-selected": "false",
      "data-vscode-context": JSON.stringify({ webviewSection: "graphFold", preventDefaultContextMenuItems: true }) }, [
      h("span", { class: `repo-band accent-${accentOf(this.accents, c.repoId)}${start ? " band-start" : ""}${end ? " band-end" : ""}`, role: "gridcell", "aria-label": name, title: name },
        start && this.layout?.repoName != null ? [h("span", { class: "repo-label", "data-name": name }, [name])] : []),
      renderGraph(this.graph.rows[index], c, this.graph.columns, this.graphWidth, this.height(), { folded: { id: segment.id, count: segment.hidden.length }, edges: this.edgeActions }),
      h("span", { role: "gridcell", class: "fold-summary" }, [h("button", { type: "button", class: "fold-expand", "data-fold-expand": segment.id,
        title: localize("Expand {0} hidden commits", segment.hidden.length), "aria-expanded": "false" }, [localize("{0} commits hidden · Expand", segment.hidden.length)])]),
      this.shown.has("hash") ? h("span", { role: "gridcell", class: "hash" }) : null,
      this.shown.has("author") ? h("span", { role: "gridcell", class: "author" }) : null,
      this.shown.has("changes") ? h("span", { role: "gridcell", class: "changes-cell" }) : null,
      this.shown.has("date") ? h("span", { role: "gridcell", class: "date" }) : null,
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
    const page = Math.max(1, Math.floor(this.viewHeight() / this.height()) - 1);
    const order = this.visibleCommitIndexes();
    const work = this.workRows() > 0, onWork = work && this.props.workSelected === true;
    const next = moveWithWork(e.key, onWork ? -1 : order.indexOf(this.props.selected), order.length, page, work);
    if (next === null) return;
    e.preventDefault();
    if (next < 0) {
      // The summary row: into view, and chosen unless it already is.
      this.setTop(0);
      if (!onWork) this.onWork();
      return;
    }
    // Scrolled first, while nothing in this task has touched the page: the scroll needs no early layout.
    this.scrollToIndex(order[next]);
    // From the summary row a range has nowhere to start: Shift moves as a plain arrow does.
    this.onSelect(order[next], { kind: "arrow", shift: e.shiftKey && !onWork });
  }

  private scrollToIndex(i: number): void {
    const rh = this.height();
    const displayIndex = this.display.sourceToDisplay.get(i);
    if (displayIndex === undefined) return;
    // Rows sit under the sticky column header, after the summary row: the room they show in is the list's less the header.
    const top = this.lead() + displayIndex * rh, room = this.viewHeight();
    if (top < this.top) this.setTop(top);
    else if (top + rh > this.top + room) this.setTop(top + rh - room);
  }
}
