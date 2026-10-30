// The Changes column's drawings as numbers, so they can be tested: GitLens's four visualizations
// (numbers, squares, bar, bipolar) and the ring the narrowest column shows. Pure: no DOM.
import type { ChangesMode, CommitStats } from "../changeStats";

/** A churn this large fills the bar: the scale is absolute (√lines), not relative to the rows on screen. */
export const FULL_CHURN = 1600;

/** How much room the column has, widest first (the Log's width picks one). */
export type ChangesStage = "full" | "compact" | "mini" | "icon";

/**
 * Per stage, in px: the column's width for a bar, for numbers and for squares (the files count,
 * the lines' total and the squares: "999+ 999k" needs about 129px), and the drawing's track.
 */
export const STAGES: Record<ChangesStage, { column: number; numbers: number; squares: number; track: number }> = {
  full: { column: 118, numbers: 124, squares: 136, track: 64 }, compact: { column: 88, numbers: 88, squares: 88, track: 52 },
  mini: { column: 52, numbers: 52, squares: 52, track: 46 }, icon: { column: 18, numbers: 28, squares: 18, track: 0 },
};
export const columnWidth = (mode: Exclude<ChangesMode, "off">, stage: ChangesStage): number =>
  (mode === "numbers" ? STAGES[stage].numbers : mode === "squares" ? STAGES[stage].squares : STAGES[stage].column);

/** The stage the Log's width allows: the subject keeps most of a narrow Log. */
export const stageFor = (logWidth: number): ChangesStage => (logWidth >= 1150 ? "full" : logWidth >= 950 ? "compact" : logWidth >= 760 ? "mini" : "icon");

/** The widest stage a column the user sized holds (the column header's sash). */
export function stageForWidth(mode: Exclude<ChangesMode, "off">, px: number): ChangesStage {
  return (["full", "compact", "mini"] as const).find((stage) => columnWidth(mode, stage) <= px) ?? "icon";
}

/** "999+" past what a count shows. */
export const capped = (n: number, cap = 999): string => (n > cap ? `${cap}+` : String(n));

/** 1234 → "1.2k", 12345 → "12k": the compact column's numbers. */
export function abbreviated(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${Math.floor(n / 100_000) / 10}M`;
}

/** The five squares: how many show added, how many deleted (a side with any line gets one at least); none for no lines. */
export function squares(s: Pick<CommitStats, "added" | "deleted">): { added: number; deleted: number } {
  const total = s.added + s.deleted;
  if (total === 0) return { added: 0, deleted: 0 };
  let added = Math.round((5 * s.added) / total), deleted = 5 - added;
  if (s.added > 0 && added === 0) { added = 1; deleted = 4; }
  if (s.deleted > 0 && deleted === 0) { deleted = 1; added = 4; }
  return { added, deleted };
}

/** A magnitude in 0..1 on the √ scale, at most 1 (FULL_CHURN lines or more). */
export const magnitude = (lines: number): number => Math.min(1, Math.sqrt(Math.max(0, lines)) / Math.sqrt(FULL_CHURN));

/** The bar: its filled share of the track and how that share splits between added and deleted. */
export function bar(s: Pick<CommitStats, "added" | "deleted">): { fill: number; addedShare: number } {
  const total = s.added + s.deleted;
  return { fill: total === 0 ? 0 : magnitude(total), addedShare: total === 0 ? 0 : s.added / total };
}

/** The bipolar bar: deletions grow left of the axis, additions right, each on its own √ scale. */
export const bipolar = (s: Pick<CommitStats, "added" | "deleted">): { left: number; right: number } => ({ left: magnitude(s.deleted), right: magnitude(s.added) });

/**
 * The ring of the narrowest column. bar and bipolar: one sweep, as long as the bar's magnitude,
 * additions clockwise from 12 o'clock and deletions counter-clockwise. squares: five segments.
 * Angles in degrees.
 */
export function ringSweep(s: Pick<CommitStats, "added" | "deleted">): { added: number; deleted: number } {
  const total = s.added + s.deleted;
  if (total === 0) return { added: 0, deleted: 0 };
  const sweep = 360 * magnitude(total);
  return { added: (sweep * s.added) / total, deleted: (sweep * s.deleted) / total };
}

/** An SVG arc path on a circle of radius r around (c, c), from `from` to `to` degrees (0 = 12 o'clock, clockwise). */
export function arcPath(c: number, r: number, from: number, to: number): string {
  const span = Math.max(0, Math.min(359.99, to - from));
  if (span === 0) return "";
  const point = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return `${(c + r * Math.cos(rad)).toFixed(2)} ${(c + r * Math.sin(rad)).toFixed(2)}`;
  };
  return `M ${point(from)} A ${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${point(from + span)}`;
}
