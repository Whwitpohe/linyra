// The Log's columns: which show and how wide, decided in one place. list.ts writes the result as
// --log-columns on .list-pane, and the rows, the column header and File History's work row all
// use it, so their cells cannot drift apart. Pure: no DOM (logColumns.test.ts).
import type { ChangesMode } from "../changeStats";
import { columnWidth, stageFor, stageForWidth, type ChangesStage } from "./changeViz";

export type ColumnId = "repo" | "graph" | "message" | "file" | "hash" | "author" | "changes" | "date";
/** The columns a sash can size; Message takes the rest, File History's change column is fixed. */
export type SizedColumn = "repo" | "graph" | "hash" | "author" | "changes" | "date";
export const SIZED: readonly SizedColumn[] = ["repo", "graph", "hash", "author", "changes", "date"];

/** What the user chose for the columns (the column header), saved by the host with the view options. */
export interface ColumnPrefs {
  /** Widths in px a sash set; a column without one has its automatic width. */
  widths: Partial<Record<SizedColumn, number>>;
  /** Hidden by the Columns menu. Repository hides its name: its color strip stays. (Hash and Changes keep their own options.) */
  hidden: ("repo" | "author" | "date")[];
  dates: "relative" | "absolute";
}
export const DEFAULT_COLUMNS: ColumnPrefs = { widths: {}, hidden: [], dates: "relative" };

/** Saved prefs as they come back from storage: anything unknown is dropped. */
export function columnPrefs(value: unknown): ColumnPrefs {
  const v = (value ?? {}) as Partial<ColumnPrefs>;
  const widths: Partial<Record<SizedColumn, number>> = {};
  for (const id of SIZED) {
    const w = (v.widths as Record<string, unknown> | undefined)?.[id];
    if (typeof w === "number" && Number.isFinite(w) && w > 0) widths[id] = Math.round(w);
  }
  const hidden = Array.isArray(v.hidden) ? (["repo", "author", "date"] as const).filter((id) => v.hidden!.includes(id)) : [];
  return { widths, hidden, dates: v.dates === "absolute" ? "absolute" : "relative" };
}

export interface ColumnInput {
  /** File History: one repository (a strip, no name) and the file's own change column. */
  history: boolean;
  /** The rows' content width: the list's client width less their side padding. */
  width: number;
  /** The list's own width, which the narrow layout and the Changes stage go by (default: `width`). */
  outer?: number;
  /** The rows' font's `ch` in px. */
  ch: number;
  /** The longest repository name, in characters. */
  repoChars: number;
  /** The graph's width when nobody sized it (graph.ts graphWidthFor: its lanes, up to a quarter). */
  graphAuto: number;
  hash: boolean;
  changes?: Exclude<ChangesMode, "off">;
  prefs: ColumnPrefs;
}

export interface Column { id: ColumnId; px: number | null }

export interface ColumnLayout {
  columns: Column[];
  /** grid-template-columns. */
  template: string;
  /** Between columns, in px. */
  gap: number;
  /** Narrow: the repository a strip, no hash or author (the user's widths wait for the wide layout). */
  narrow: boolean;
  /** Narrower still: File History's change is its letter alone. */
  tiny: boolean;
  changesStage?: ChangesStage;
  /** The repository column's width while it shows names (fitNames), else null. */
  repoName: number | null;
  graph: number;
}

/** Below this list width the narrow layout takes over (the JetBrains Log's root column becomes its strip). */
export const NARROW = 720;
export const TINY = 440;
/** Message keeps at least this much: sized columns give way before it does. */
export const MESSAGE_MIN = 120;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function layoutColumns(input: ColumnInput): ColumnLayout {
  const { history, width, ch, prefs } = input;
  const listWidth = input.outer ?? width;
  const narrow = listWidth < NARROW, tiny = history && listWidth < TINY;
  const gap = narrow ? 6 : 10;
  const hidden = new Set(prefs.hidden);
  // Each sized column: its automatic width, its range, and the user's width (wide layout only).
  const sized = (id: SizedColumn, auto: number, lo: number, hi: number) => {
    const user = narrow ? undefined : prefs.widths[id];
    return { auto, lo, hi, px: user === undefined ? auto : clamp(user, lo, Math.max(lo, hi)), user: user !== undefined };
  };
  type Entry = { id: ColumnId; px: number | null; size?: ReturnType<typeof sized> };
  const cols: Entry[] = [];
  const add = (id: ColumnId, px: number | null, size?: ReturnType<typeof sized>) => cols.push({ id, px: size ? size.px : px, size });

  // Repository: the name's column (the longest name + 2ch, up to a quarter), or its strip.
  const repoNamed = !history && !narrow && !hidden.has("repo");
  if (repoNamed) add("repo", null, sized("repo", Math.max(72, Math.min((input.repoChars + 2) * ch, 0.25 * width)), 72, 0.4 * width));
  else add("repo", history ? 4 : 3);
  add("graph", null, sized("graph", input.graphAuto, 28, 0.5 * width));
  add("message", null);
  if (history) add("file", (tiny ? 2 : narrow ? 11 : 14) * ch);
  if (input.hash && !narrow) add("hash", null, sized("hash", 8.5 * ch, 5 * ch, 40 * ch));
  if (!narrow && !hidden.has("author")) add("author", null, sized("author", Math.max(48, 10 * ch), 48, 30 * ch));
  let changesStage: ChangesStage | undefined;
  if (input.changes && !history) {
    const mode = input.changes;
    const auto = columnWidth(mode, narrow ? "icon" : stageFor(listWidth));
    const size = sized("changes", auto, columnWidth(mode, "icon"), columnWidth(mode, "full") * 2);
    changesStage = narrow ? "icon" : size.user ? stageForWidth(mode, size.px) : stageFor(listWidth);
    add("changes", null, size);
  }
  if (!hidden.has("date")) {
    const auto = (prefs.dates === "absolute" ? 16 : narrow && input.changes && !history ? 7 : 8) * ch;
    add("date", null, sized("date", auto, 6 * ch, 30 * ch));
  }

  // Message keeps its minimum: the user's widths give way first (widest first), down to automatic
  // (one already narrower than that stays as it is: giving way never widens a column).
  const room = () => width - gap * (cols.length - 1) - cols.reduce((sum, c) => sum + (c.px ?? 0), 0);
  for (const c of [...cols].filter((c) => c.size?.user).sort((a, b) => (b.px ?? 0) - (a.px ?? 0))) {
    const short = MESSAGE_MIN - room();
    if (short <= 0) break;
    c.px = Math.max(Math.min(c.size!.auto, c.px!), c.size!.lo, c.px! - short);
  }
  const columns = cols.map(({ id, px }) => ({ id, px: px === null ? null : Math.round(px) }));
  const changes = columns.find((c) => c.id === "changes");
  if (changes && changesStage && cols.find((c) => c.id === "changes")?.size?.user) changesStage = stageForWidth(input.changes!, changes.px!);
  return {
    columns,
    template: columns.map((c) => (c.px === null ? "minmax(0, 1fr)" : `${c.px}px`)).join(" "),
    gap, narrow, tiny, changesStage,
    repoName: repoNamed ? columns[0].px : null,
    graph: columns.find((c) => c.id === "graph")!.px!,
  };
}
