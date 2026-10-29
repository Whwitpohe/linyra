import "./changesColumn.css";
import type { ChangesMode, CommitStats } from "../changeStats";
import { localize } from "../i18n";
import type { WebviewMessage } from "../protocol";
import { abbreviated, arcPath, bar, bipolar, capped, ringSweep, squares, type ChangesStage } from "./changeViz";
import { codiconElement } from "./codicons";
import { h } from "./dom";

/**
 * The Log's Changes column, as GitLens's Commit Graph draws it: a commit's files and lines as
 * numbers, five squares, a bar, or a bipolar bar, with as much as the column's width holds
 * (stages: files icon + count + drawing; count + drawing; drawing; a ring). Every drawing is one
 * element painted with gradients (or one small SVG), so a row stays light while scrolling.
 */

/** Per stage, in px: the column's width for a drawing and for numbers, and the drawing's track. */
export const STAGES: Record<ChangesStage, { column: number; numbers: number; track: number }> = {
  full: { column: 118, numbers: 124, track: 64 }, compact: { column: 88, numbers: 88, track: 52 },
  mini: { column: 52, numbers: 52, track: 46 }, icon: { column: 18, numbers: 28, track: 0 },
};
export const columnWidth = (mode: Exclude<ChangesMode, "off">, stage: ChangesStage): number => (mode === "numbers" ? STAGES[stage].numbers : STAGES[stage].column);

/** The stage the Log's width allows: the subject keeps most of a narrow Log. */
export const stageFor = (logWidth: number): ChangesStage => (logWidth >= 1150 ? "full" : logWidth >= 950 ? "compact" : logWidth >= 760 ? "mini" : "icon");

/** Stats read this session (they never change), by repoId\0sha: rows drawn later find them at once. */
const stats = new Map<string, CommitStats>();
export const statsKeyOf = (repoId: string, sha: string): string => `${repoId}\0${sha}`;
export const statsFor = (repoId: string, sha: string): CommitStats | undefined => stats.get(statsKeyOf(repoId, sha));

export function statsLabel(s: CommitStats): string {
  return localize("{0} files changed, {1} lines added, {2} lines deleted", s.files, s.added, s.deleted);
}

const px = (n: number) => `${Math.round(n * 10) / 10}px`;
const ADD = "var(--changes-added)", DEL = "var(--changes-deleted)", TRACK = "var(--changes-track)", NOTCH = "var(--changes-notch)";

/** A deleted run's notch, centred in it: tells deleted from added without the colors. */
const notch = (from: number, width: number) => `linear-gradient(${NOTCH}, ${NOTCH}) ${px(from + width / 4)} 50% / ${px(width / 2)} 1.5px no-repeat`;

function drawing(s: CommitStats, mode: Exclude<ChangesMode, "off" | "numbers">, track: number): HTMLElement {
  const el = h("span", { class: `changes-draw changes-${mode}`, "aria-hidden": "true" });
  el.style.width = `${track}px`;
  const layers: string[] = [];
  if (mode === "squares") {
    const q = squares(s), cell = 8, gap = 2;
    el.style.width = `${5 * cell + 4 * gap}px`;
    for (let i = 0; i < 5; i++) {
      const color = i < q.added ? ADD : i < q.added + q.deleted ? DEL : TRACK;
      if (color === DEL) layers.push(notch(i * (cell + gap), cell));
      layers.push(`linear-gradient(${color}, ${color}) ${i * (cell + gap)}px 50% / ${cell}px ${cell}px no-repeat`);
    }
  } else if (mode === "bar") {
    const b = bar(s), fill = s.added + s.deleted > 0 ? Math.max(6, b.fill * track) : 0, green = fill * b.addedShare;
    if (fill - green > 0) layers.push(notch(green, fill - green));
    layers.push(`linear-gradient(to right, ${ADD} 0 ${px(green)}, ${DEL} ${px(green)} ${px(fill)}, ${TRACK} ${px(fill)})`);
  } else {
    const p = bipolar(s), half = (track - 1) / 2, left = p.left * half, right = p.right * half;
    if (left > 0) layers.push(notch(half - left, left));
    layers.push(`linear-gradient(to right, ${TRACK} 0 ${px(half - left)}, ${DEL} ${px(half - left)} ${px(half)}, var(--changes-axis) ${px(half)} ${px(half + 1)}, ${ADD} ${px(half + 1)} ${px(half + 1 + right)}, ${TRACK} ${px(half + 1 + right)})`);
  }
  el.style.background = layers.join(", ");
  return el;
}

const SVG = "http://www.w3.org/2000/svg";
/** The narrowest column's glyph: a 16px ring (a sweep for bar and bipolar, five segments for squares). */
function ring(s: CommitStats, mode: ChangesMode): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "changes-ring");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = (cls: string, d: string) => {
    if (!d) return;
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("class", cls);
    p.setAttribute("d", d);
    svg.append(p);
  };
  let added = "", deleted = "", track = "";
  if (mode === "squares") {
    const q = squares(s);
    for (let i = 0; i < 5; i++) {
      const d = arcPath(8, 6, i * 72 + 5.5, i * 72 + 66.5);
      if (i < q.added) added += d; else if (i < q.added + q.deleted) deleted += d; else track += d;
    }
  } else {
    // The whole ring is the track (a circle: an arc that ends where it starts is no arc at all).
    const circle = document.createElementNS(SVG, "circle");
    circle.setAttribute("class", "changes-ring-track");
    circle.setAttribute("cx", "8");
    circle.setAttribute("cy", "8");
    circle.setAttribute("r", "6");
    svg.append(circle);
    const r = ringSweep(s);
    added = arcPath(8, 6, 0, r.added);
    deleted = arcPath(8, 6, 360 - r.deleted, 360);
  }
  path("changes-ring-track", track);
  path("changes-ring-added", added);
  path("changes-ring-deleted", deleted);
  return svg;
}

/** A row's Changes cell. No stats yet: an empty cell, filled in when they arrive (CommitList.statsArrived). */
export function changesCell(s: CommitStats | undefined, mode: Exclude<ChangesMode, "off">, stage: ChangesStage): HTMLElement {
  const cell = h("span", { class: "changes-cell", role: "gridcell", "aria-label": s ? statsLabel(s) : undefined });
  if (!s) { cell.classList.add("pending"); return cell; }
  if (stage === "icon") {
    cell.append(mode === "numbers" ? h("span", { class: "changes-files" }, [capped(s.files, 99)]) : ring(s, mode));
    return cell;
  }
  if (mode === "numbers") {
    // Full: the files and both counts (abbreviated past 9999); compact: both counts, abbreviated; mini: the lines changed.
    if (stage === "full") cell.append(h("span", { class: "changes-files" }, [codiconElement("files", "changes-files-icon"), capped(s.files)]));
    const n = stage === "full" ? (v: number) => (v < 10_000 ? String(v) : abbreviated(v)) : abbreviated;
    cell.append(stage === "mini"
      ? h("span", { class: "changes-numbers" }, [`±${abbreviated(s.added + s.deleted)}`])
      : h("span", { class: "changes-numbers" }, [h("span", { class: "count-added" }, [`+${n(s.added)}`]), h("span", { class: "count-deleted" }, [`−${n(s.deleted)}`])]));
    return cell;
  }
  // The files count: with its icon when there is room; squares in the compact column show their total instead (one number).
  if (stage === "full" || (stage === "compact" && mode !== "squares")) {
    cell.append(h("span", { class: "changes-files" }, [stage === "full" ? codiconElement("files", "changes-files-icon") : null, capped(s.files)]));
  }
  if (mode === "squares" && stage !== "mini") cell.append(h("span", { class: "changes-total" }, [abbreviated(s.added + s.deleted)]));
  cell.append(drawing(s, mode, STAGES[stage].track));
  return cell;
}

/**
 * Asks the host for the stats of the rows on screen once they settle (a fast scroll asks for
 * nothing on the way), and keeps what comes back for the session. `patch` redraws the cells of
 * the commits that arrived.
 */
export class ChangesFeed {
  private timer: ReturnType<typeof setTimeout> | undefined;
  enabled = false;

  constructor(
    private readonly rows: HTMLElement,
    private readonly commitAt: (index: number) => { repoId: string; sha: string } | undefined,
    private readonly post: (m: WebviewMessage) => void,
    private readonly patch: (keys: ReadonlySet<string>) => void,
  ) {
    new MutationObserver(() => {
      if (!this.enabled) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.report(), 150);
    }).observe(rows, { childList: true });
  }

  /** The host's batch: [files, added, deleted] by repoId\0sha. */
  receive(byKey: Record<string, [number, number, number]>): void {
    const keys = new Set<string>();
    for (const [key, v] of Object.entries(byKey)) {
      if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => Number.isFinite(n) && n >= 0)) continue;
      stats.set(key, { files: v[0], added: v[1], deleted: v[2] });
      keys.add(key);
    }
    if (keys.size > 0) this.patch(keys);
  }

  /** The mode just turned on: ask for what is on screen now. */
  refresh(): void {
    this.report();
  }

  /**
   * Everything on screen without stats yet. Asked again on every settle until it arrives: the
   * host kills a request a newer one supersedes, and answers from memory what it already read.
   */
  private report(): void {
    if (!this.enabled) return;
    const commits: { repoId: string; sha: string }[] = [];
    for (const row of this.rows.querySelectorAll<HTMLElement>(".row[data-index]")) {
      const c = this.commitAt(Number(row.dataset.index));
      if (c && !stats.has(statsKeyOf(c.repoId, c.sha))) commits.push({ repoId: c.repoId, sha: c.sha });
    }
    if (commits.length > 0) this.post({ type: "wantStats", commits });
  }
}
