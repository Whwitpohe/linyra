// Visual History: one bubble per commit, time along x, one row per author. SVG, theme colors only.
import { authorKey, authorRows, bubbleRange, moveFocus, radiusScale, rowOrder, timeDomain, timeTicks, type AuthorRow, type MoveKey, type TickUnit } from "../../insights/bubbles";
import type { BubbleCommit, HistoryData, InsightsRepo } from "../../insights/protocol";
import type { ColorBy } from "../../insights/range";
import { language, localize } from "../../i18n";
import { h } from "../dom";
import { authorDiscHtml } from "../ui/authorDisc";
import { renderLines } from "../ui/counts";

const SVG_NS = "http://www.w3.org/2000/svg";
/** A row's height at least, and at most when few authors share a tall chart. */
const ROW_MIN = 30;
const ROW_MAX = 60;
const AXIS = 22;
const ACCENTS = 8;
const MOVES = new Set<string>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

export interface HistoryContext {
  repos: ReadonlyMap<string, InsightsRepo>;
  colorBy: ColorBy;
  reveal(c: BubbleCommit): void;
  /** Hover or keyboard focus: the tooltip for a commit at a screen point (undefined hides it). */
  tooltip(c: BubbleCommit | undefined, at?: DOMRect): void;
  announce(text: string): void;
}

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

const tickFormats: Record<TickUnit, Intl.DateTimeFormatOptions> = {
  day: { month: "short", day: "numeric" },
  week: { month: "short", day: "numeric" },
  month: { month: "short", year: "numeric" },
  quarter: { month: "short", year: "numeric" },
  year: { year: "numeric" },
};

export function commitDate(time: number): string {
  return new Intl.DateTimeFormat(language(), { dateStyle: "medium", timeStyle: "short" }).format(new Date(time * 1000));
}

/** What a commit's bubble says to a screen reader (and the status line on keyboard focus). */
export function describeCommit(c: BubbleCommit, repo: string): string {
  return localize("{0} — {1}, {2}, {3}, {4} lines added, {5} deleted", c.subject, c.author, repo, commitDate(c.time), c.added, c.deleted);
}

/** The commit's tooltip: subject, repository, author, date, id, lines and files. */
export function commitTooltip(c: BubbleCommit, repo: InsightsRepo | undefined): HTMLElement[] {
  return [
    h("div", { class: "tip-subject" }, [c.subject || localize("(no message)")]),
    h("div", { class: "tip-line" }, [
      h("span", { class: `tip-repo accent-${repo?.accent ?? 0}` }, [repo?.name ?? ""]),
      h("span", { class: "tip-muted" }, [c.author]),
      h("span", { class: "tip-muted" }, [commitDate(c.time)]),
    ]),
    h("div", { class: "tip-line" }, [
      h("code", { class: "tip-sha" }, [c.sha.slice(0, 7)]),
      renderLines(c.added, c.deleted),
      h("span", { class: "tip-muted" }, [localize(c.files === 1 ? "{0} file" : "{0} files", c.files)]),
    ]),
    h("div", { class: "tip-hint" }, [localize("Click or press Enter to show it in the Log")]),
  ];
}

/** Draws Visual History into `host` and keeps it current with its size. */
export class HistoryChart {
  private data: HistoryData | undefined;
  private ctx: HistoryContext | undefined;
  private commits: BubbleCommit[] = [];
  private rows: AuthorRow[] = [];
  private rowOf: number[] = [];
  private times: number[] = [];
  private order: number[][] = [];
  private focused: number | undefined;
  private circles: SVGCircleElement[] = [];
  private frame = 0;
  /** The row height the last drawing used. */
  private row = ROW_MIN;

  /** The scrolling box, kept across drawings so its scroll position stays. */
  private readonly scroll = h("div", { class: "history-scroll" });

  constructor(private readonly host: HTMLElement) {
    host.append(this.scroll);
    new ResizeObserver(() => this.schedule()).observe(host);
    host.addEventListener("keydown", (e) => this.key(e));
    host.addEventListener("focus", () => { if (this.focused === undefined) this.move("End"); else this.showFocus(); });
    host.addEventListener("blur", () => this.ctx?.tooltip(undefined));
    host.addEventListener("pointerover", (e) => {
      const i = this.indexOf(e.target);
      if (i !== undefined) this.ctx?.tooltip(this.commits[i], (e.target as Element).getBoundingClientRect());
    });
    host.addEventListener("pointerout", (e) => {
      if (this.indexOf(e.target) !== undefined) this.ctx?.tooltip(undefined);
    });
    host.addEventListener("click", (e) => {
      const i = this.indexOf(e.target);
      if (i === undefined) return;
      this.setFocus(i, false);
      this.ctx?.reveal(this.commits[i]);
    });
  }

  render(data: HistoryData, ctx: HistoryContext): void {
    const same = this.data === data;
    this.data = data;
    this.ctx = ctx;
    if (!same) {
      // The keyboard's commit stays focused when the same commit is in the new answer.
      const was = this.focusedCommit;
      // Newest last within a row, so the keyboard's → walks forward in time.
      this.commits = data.commits;
      this.rows = authorRows(this.commits);
      const rowIndex = new Map(this.rows.map((r, i) => [r.key, i]));
      this.rowOf = this.commits.map((c) => rowIndex.get(authorKey(c.author, c.email)) ?? 0);
      this.times = this.commits.map((c) => c.time);
      this.order = rowOrder(this.rowOf, this.times, this.rows.length);
      const at = was ? this.commits.findIndex((c) => c.sha === was.sha && c.repoId === was.repoId) : -1;
      this.focused = at < 0 ? undefined : at;
    }
    this.draw();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.data && this.host.isConnected && this.host.offsetParent !== null) this.draw();
    });
  }

  private indexOf(target: EventTarget | null): number | undefined {
    const i = target instanceof SVGCircleElement ? Number(target.dataset.i) : NaN;
    return Number.isInteger(i) ? i : undefined;
  }

  private colorOf(c: BubbleCommit, row: number): number {
    return this.ctx?.colorBy === "author" ? row % ACCENTS : this.ctx?.repos.get(c.repoId)?.accent ?? 0;
  }

  private draw(): void {
    const data = this.data, ctx = this.ctx;
    if (!data || !ctx) return;
    // The scroll box keeps its scrollbar's gutter, so the width does not change when rows overflow.
    const width = Math.max(240, this.scroll.clientWidth);
    const narrow = width < 520;
    const label = narrow ? 38 : Math.min(200, Math.max(120, width * 0.18));
    const ROW = (this.row = Math.max(ROW_MIN, Math.min(ROW_MAX, Math.floor((this.scroll.clientHeight - AXIS - 2) / Math.max(1, this.rows.length)))));
    let busiest = 1;
    for (const list of this.order) busiest = Math.max(busiest, list.length);
    const size = bubbleRange(busiest, width - label - 12, ROW);
    // Room for a whole bubble at either end: the oldest does not run under the authors' counts.
    const left = label + size.max + 4, plot = width - left - size.max - 8;
    const [from, to] = timeDomain(data.since, data.now, this.times);
    const x = (t: number) => left + ((t - from) / (to - from)) * plot;
    const r = radiusScale(this.commits.map((c) => c.added + c.deleted), size.min, size.max);

    const axis = svg("svg", { class: "history-axis", width, height: AXIS, "aria-hidden": "true" });
    const ticks = timeTicks(from, to, plot);
    const grid = svg("g", { class: "history-grid" });
    for (const t of ticks) {
      const tx = x(t.time);
      const text = svg("text", { x: tx, y: AXIS - 7, class: "history-tick" });
      text.textContent = new Intl.DateTimeFormat(language(), tickFormats[t.unit]).format(new Date(t.time * 1000));
      axis.append(text, svg("line", { x1: tx, x2: tx, y1: AXIS - 4, y2: AXIS, class: "history-tick-mark" }));
      grid.append(svg("line", { x1: tx, x2: tx, y1: 0, y2: this.rows.length * ROW, class: "history-gridline" }));
    }

    const body = h("div", { class: "history-body" });
    const labels = h("div", { class: "history-labels" });
    labels.style.width = `${label}px`;
    this.rows.forEach((row, i) => {
      const repo = ctx.repos.get(row.topRepo);
      const accent = ctx.colorBy === "author" ? i % ACCENTS : repo?.accent ?? 0;
      const count = localize(row.count === 1 ? "{0} commit" : "{0} commits", row.count);
      const line = h("div", { class: "history-author", title: `${row.name} <${row.email}> · ${count}` }, [
        authorDiscHtml({ name: row.name, email: row.email, accent }, 20),
        narrow ? null : h("span", { class: "history-author-name" }, [row.name]),
        narrow ? null : h("span", { class: "history-author-count" }, [String(row.count)]),
      ]);
      line.style.height = `${ROW}px`;
      labels.append(line);
    });

    const height = this.rows.length * ROW;
    const plotSvg = svg("svg", { class: "history-plot", width, height, "aria-hidden": "true" });
    const stripes = svg("g", { class: "history-rows" });
    this.rows.forEach((_, i) => stripes.append(svg("rect", { x: label, y: i * ROW, width: width - label - 4, height: ROW, class: i % 2 ? "history-row odd" : "history-row" })));
    plotSvg.append(stripes, grid);
    // Biggest first: a small commit on top of a big one stays clickable.
    const radii = this.commits.map((c) => r(c.added + c.deleted));
    const paint = this.commits.map((_, i) => i).sort((a, b) => radii[b] - radii[a] || a - b);
    const bubbles = svg("g", { class: "history-bubbles" });
    this.circles = new Array(this.commits.length);
    for (const i of paint) {
      const c = this.commits[i];
      const circle = svg("circle", { cx: x(c.time), cy: this.rowOf[i] * ROW + ROW / 2, r: radii[i], class: `bubble accent-${this.colorOf(c, this.rowOf[i])}`, "data-i": i });
      this.circles[i] = circle;
      bubbles.append(circle);
    }
    plotSvg.append(bubbles);
    body.append(labels, plotSvg);
    this.scroll.replaceChildren(axis, body);
    if (this.focused !== undefined) this.circles[this.focused]?.classList.add("focused");
  }

  private key(e: KeyboardEvent): void {
    if (MOVES.has(e.key)) {
      e.preventDefault();
      this.move(e.key as MoveKey);
    } else if ((e.key === "Enter" || e.key === " ") && this.focused !== undefined) {
      e.preventDefault();
      this.ctx?.reveal(this.commits[this.focused]);
    } else if (e.key === "Escape") {
      this.ctx?.tooltip(undefined);
    }
  }

  private move(key: MoveKey): void {
    const next = moveFocus(this.order, this.times, this.rowOf, this.focused, key);
    if (next !== undefined) this.setFocus(next, true);
  }

  private setFocus(i: number, announce: boolean): void {
    if (this.focused !== undefined) this.circles[this.focused]?.classList.remove("focused");
    this.focused = i;
    const circle = this.circles[i];
    if (!circle) return;
    circle.classList.add("focused");
    // On top of its neighbors while focused.
    circle.parentNode?.append(circle);
    if (announce) this.showFocus();
  }

  private showFocus(): void {
    const i = this.focused;
    if (i === undefined || !this.ctx) return;
    const circle = this.circles[i];
    const scroll = this.scroll;
    if (circle) {
      const top = this.rowOf[i] * this.row, bottom = top + this.row + AXIS;
      if (top < scroll.scrollTop) scroll.scrollTop = top;
      else if (bottom > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = bottom - scroll.clientHeight;
    }
    const c = this.commits[i];
    this.ctx.tooltip(c, circle?.getBoundingClientRect());
    this.ctx.announce(describeCommit(c, this.ctx.repos.get(c.repoId)?.name ?? ""));
  }

  /** Test seam and the harness: the focused commit. */
  get focusedCommit(): BubbleCommit | undefined {
    return this.focused === undefined ? undefined : this.commits[this.focused];
  }
}
