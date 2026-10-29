// Dev-only File History mock: one file's commits, each with its status letter and lines, as
// git log --raw --numstat gives them; the file's uncommitted change. Neutral names only.
import { hashQuery, type FilterState } from "../../../src/filterModel";
import type { HistoryWork } from "../../../src/protocol";
import type { Commit } from "../../../src/types";

export interface MockHistory { repoId: string; repoName: string; path: string }

/** The files with a history in the mock workspace. Any other path was never committed. */
const FILES: Record<string, { every: number; renamedFrom?: string; binary?: boolean }> = {
  "src/client.ts": { every: 3, renamedFrom: "src/api-client.ts" },
  "README.md": { every: 5 },
  "media/logo.png": { every: 7, binary: true },
};

/**
 * The commits of `all` that touched the file, newest first: the oldest added it, one in the
 * middle renamed it (the ones before have its old name), the others modified it. Parents are the
 * next older row, as if git had rewritten them. The Log's message search still applies.
 */
export function historyRows(all: readonly Commit[], h: MockHistory, f: FilterState): Commit[] {
  const spec = FILES[h.path];
  if (!spec) return [];
  const text = hashQuery(f.text) ? "" : f.text.trim().toLowerCase();
  const touching = all.filter((c) => c.repoId === h.repoId).filter((_, i) => i % spec.every === 0);
  const renameAt = spec.renamedFrom ? Math.floor(touching.length / 2) : -1;
  return touching.map((c, i): Commit => {
    const n = parseInt(c.sha.slice(0, 6), 16);
    const lines = spec.binary ? { added: null, deleted: null } : { added: (n % 40) + 1, deleted: i === touching.length - 1 ? 0 : n % 13 };
    const older = renameAt >= 0 && i > renameAt;
    const path = older ? spec.renamedFrom! : h.path;
    const file: NonNullable<Commit["file"]> = i === touching.length - 1 ? { path, status: "A", ...lines }
      : i === renameAt ? { path, oldPath: spec.renamedFrom, status: "R", ...lines }
      : { path, status: "M", ...lines };
    return { ...c, parents: touching[i + 1] ? [touching[i + 1].sha] : [], file };
  }).filter((c) => !text || c.subject.toLowerCase().includes(text));
}

/** ?work=off: no uncommitted change. Otherwise the file is modified, or new when never committed. */
export function historyWork(h: MockHistory | null, params: URLSearchParams): HistoryWork | null {
  if (!h || params.get("work") === "off") return null;
  if (!FILES[h.path]) return { path: h.path, status: "A", untracked: true, staged: false, partlyStaged: false };
  if (FILES[h.path].binary) return null;
  return { path: h.path, status: "M", untracked: false, staged: true, partlyStaged: true, added: 4, deleted: 2 };
}
