// Files by kind of change, as the Uncommitted rows, the hover card and File History count them.
// Pure: no DOM, no vscode.
import type { FileChange } from "./types";

export interface KindCounts { added: number; modified: number; deleted: number; renamed: number }

export const NO_KINDS: KindCounts = { added: 0, modified: 0, deleted: 0, renamed: 0 };

const kindOf = (f: FileChange): keyof KindCounts =>
  f.status === "A" || f.status === "C" || f.untracked ? "added" : f.status === "D" ? "deleted" : f.status === "R" ? "renamed" : "modified";

/**
 * Distinct files by kind. A path listed twice (staged, then changed again) counts once, by its
 * stronger kind: a new or deleted file is that, whatever else happened to it.
 */
export function kindCounts(files: Iterable<FileChange>): KindCounts {
  const kinds = new Map<string, keyof KindCounts>();
  for (const f of files) {
    const k = kindOf(f);
    if (!kinds.has(f.path) || k !== "modified") kinds.set(f.path, k);
  }
  const out = { ...NO_KINDS };
  for (const k of kinds.values()) out[k]++;
  return out;
}

export const totalFiles = (c: KindCounts): number => c.added + c.modified + c.deleted + c.renamed;

export function sumKinds(all: Iterable<KindCounts>): KindCounts {
  const out = { ...NO_KINDS };
  for (const c of all) for (const k of Object.keys(out) as (keyof KindCounts)[]) out[k] += c[k];
  return out;
}

/** Lines added and deleted; binary files (null counts) add nothing. */
export function lineTotals(files: Iterable<FileChange>): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const f of files) {
    added += f.added ?? 0;
    deleted += f.deleted ?? 0;
  }
  return { added, deleted };
}
