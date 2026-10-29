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
import { accentOf, moveSelection, relativeTime, repoColumnChars, separateAdjacentAccents, visibleRange } from "./view";
import { avatarKey } from "./ui/authorDisc";
import type { ChangesMode } from "../changeStats";
import type { ChangesStage } from "./changeViz";
import { changesCell, columnWidth, stageFor, statsFor, statsKeyOf } from "./changesColumn";

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
  /** The Changes column's drawing (the ⋯ menu); none: no column. Not in File History, which has its own. */
  changes?: Exclude<ChangesMode, "off">;
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
      this.forgetLayout();
      this.paint();
    });
    // Dragging a divider narrows the Log without a window resize: re-fit the repo names.
    new ResizeObserver(() => {
      this.forgetLayout();
      this.paint();
    }).observe(root);
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
      // A plain click on a branch pill also shows that branch (where: main.ts's onRevealBranch).
      const pill = (e.target as Element).closest<HTMLElement>(".row-ref[data-ref]");
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
    this.props = next;
    this.root.classList.toggle("hash-column", next.hashColumn === true);
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
      || next.upstream !== prev.upstream || next.changes !== prev.changes;
    if (moved && next.selected >= 0) this.scrollToIndex(next.selected);
    if (drawn) this.paint();
    else if (moved || next.selectedKeys !== prev.selectedKeys) { this.paintSelection(); this.paint(true); }
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
    this.root.scrollTop = 0;
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
    // Nothing folded: the shown rows are the loaded ones, whose parent index is current.
    this.graph = layoutGraph(commits, this.accents, this.display.hiddenCount === 0 ? this.parents : undefined);
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
      // The graph's width (and the hash column, File History) set the references cell's room.
      this.refRoom = undefined;
      this.listWidth = this.root.clientWidth;
      this.graphWidth = graphWidthFor(this.graph.columns, this.listWidth * 0.24);
      const changes = this.changesShown();
      this.root.classList.toggle("with-changes", changes);
      if (changes) {
        this.changesStage = stageFor(this.listWidth);
        this.root.style.setProperty("--changes-col", `${columnWidth(this.props.changes!, this.changesStage)}px`);
      }
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
    this.fitNames(built);
    this.fitReferences(built);
    if (selected >= 0 && selected < rows.length) this.root.setAttribute("aria-activedescendant", `row-${selected}`);
    else this.root.removeAttribute("aria-activedescendant");
  }

  /**
   * A repo name longer than its column is cut in the middle, to exactly what fits: repos
   * that share a prefix differ at the end, and the browser's own ellipsis would hide it.
   * The full name stays in the band's tooltip and accessible name.
   */
  private fitNames(rows: readonly HTMLElement[]): void {
    const first = rows[0];
    if (!first) return;
    const labels = rows.flatMap((row) => [...row.querySelectorAll<HTMLElement>(".repo-label")]);
    if (labels.length === 0) return;
    // Every name shares one font and inset: read them once per layout change (a resize, a theme),
    // then only write. The column's width is worked out, not read: reading the grid's tracks
    // laid out every row just built, and the names written after it laid them out again.
    if (!this.column) {
      const label = textStyle(labels[0]), band = textStyle(labels[0].parentElement!), row = textStyle(first);
      this.column = { font: label.font, paddingX: label.paddingX + band.paddingX, rowPaddingX: row.paddingX, ch: chWidth(label.font) };
    }
    const { font, paddingX, rowPaddingX, ch } = this.column;
    // styles.css: minmax(72px, min(var(--repo-col), 25%)), --repo-col being the longest name + 2ch (main.ts).
    const width = Math.max(72, Math.min((this.repoChars() + 2) * ch, 0.25 * (this.listWidth - rowPaddingX)));
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
    const showName = start || displayIndex === Math.floor(this.root.scrollTop / this.height());
    const segmentId = this.nodeSegments.get(i), segment = segmentId === undefined ? undefined : this.segmentById.get(segmentId);
    const ago = relativeTime(this.props.now, c.time);
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
      this.props.hashColumn ? h("span", { class: "hash", role: "gridcell" }, [c.sha.slice(0, 8)]) : null,
      h("span", { class: "author", role: "gridcell" }, [c.author]),
      this.changesShown() ? changesCell(statsFor(c.repoId, c.sha), this.props.changes!, this.changesStage) : null,
      h("span", { class: "date", role: "gridcell", "aria-label": whenLabel(this.props.now, c.time, ago) }, [ago]),
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
    return h("div", { class: "row folded-row", role: "row", "aria-rowindex": String(index + 1), "aria-selected": "false",
      "data-vscode-context": JSON.stringify({ webviewSection: "graphFold", preventDefaultContextMenuItems: true }) }, [
      h("span", { class: `repo-band accent-${accentOf(this.accents, c.repoId)}${start ? " band-start" : ""}${end ? " band-end" : ""}`, role: "gridcell", "aria-label": name, title: name },
        start ? [h("span", { class: "repo-label", "data-name": name }, [name])] : []),
      renderGraph(this.graph.rows[index], c, this.graph.columns, this.graphWidth, this.height(), { folded: { id: segment.id, count: segment.hidden.length }, edges: this.edgeActions }),
      h("span", { role: "gridcell", class: "fold-summary" }, [h("button", { type: "button", class: "fold-expand", "data-fold-expand": segment.id,
        title: localize("Expand {0} hidden commits", segment.hidden.length), "aria-expanded": "false" }, [localize("{0} commits hidden · Expand", segment.hidden.length)])]),
      this.props.hashColumn ? h("span", { role: "gridcell", class: "hash" }) : null,
      h("span", { role: "gridcell", class: "author" }),
      this.changesShown() ? h("span", { role: "gridcell", class: "changes-cell" }) : null,
      h("span", { role: "gridcell", class: "date" }),
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
