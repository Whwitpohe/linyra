// The Log's summary row of uncommitted work, above the newest commit (list.ts draws it). Pure: no DOM.
import type { KindCounts } from "../changeKinds";
import type { FilterState } from "../filterModel";
import type { WorkRow } from "../protocol";
import { moveSelection } from "./view";

export interface WorkSummary {
  /** The repositories with work, most recently edited first (the Uncommitted side's order). */
  repos: readonly WorkRow[];
  files: number;
  /** Files by kind, summed over the repositories (+3 ✎2 −1). */
  kinds: KindCounts;
  added: number;
  deleted: number;
  /** The latest edit as the Uncommitted side words it ("edited 2m ago"), or "". */
  edited: string;
  /** The same edit as a time (ms), or null when not known. */
  editedAt: number | null;
}

export interface WorkSummaryInput {
  mode: "commits" | "uncommitted";
  /** File History has its own row for its file's change (history.ts). */
  history: boolean;
  work: { known: boolean; totals: { files: number; added: number; deleted: number }; rows: readonly WorkRow[] };
  filter: FilterState;
  /** Local YYYY-MM-DD: a date range that ended before today shows no work. */
  today: string;
}

/**
 * The Log is looking for particular commits: words or a hash, an author, a file, or a date range
 * that ended before today. Uncommitted work is not among what it looks for, and the row stays out.
 */
export function lookingForCommits(f: FilterState, today: string): boolean {
  return f.text.trim() !== "" || f.author.trim() !== "" || f.mine || (f.authors?.length ?? 0) > 0 || !!f.path?.trim()
    || (f.date === "custom" && !!f.to && f.to < today);
}

/** The row, or null: only on the Commits side, outside File History, with work in the ticked repositories. */
export function workSummary(i: WorkSummaryInput): WorkSummary | null {
  if (i.mode !== "commits" || i.history || !i.work.known || i.work.rows.length === 0 || i.work.totals.files === 0) return null;
  if (lookingForCommits(i.filter, i.today)) return null;
  const { files, added, deleted } = i.work.totals;
  const kinds: KindCounts = { added: 0, modified: 0, deleted: 0, renamed: 0 };
  for (const r of i.work.rows) for (const k of Object.keys(kinds) as (keyof KindCounts)[]) kinds[k] += r.counts[k];
  return { repos: i.work.rows, files, kinds, added, deleted, edited: i.work.rows[0].edited, editedAt: i.work.rows[0].editedAt };
}

/** Its content as a key: the row is built again only when this changes. */
export function summaryKey(s: WorkSummary | null | undefined): string {
  return s ? JSON.stringify([s.repos.map((r) => [r.repoId, r.counts, r.canStage, r.hasStaged, r.hasChanges]), s.files, s.added, s.deleted, s.edited, s.editedAt]) : "";
}

/**
 * ↑ ↓ Home End PageUp PageDown over the summary row and the commits: the row comes first (-1),
 * then the commits in their order (0…total-1). `index` -1 with the row is the row itself.
 */
export function moveWithWork(key: string, index: number, total: number, pageRows: number, work: boolean): number | null {
  if (!work) return moveSelection(key, index, total, pageRows);
  const next = moveSelection(key, index + 1, total + 1, pageRows);
  return next === null ? null : next - 1;
}
