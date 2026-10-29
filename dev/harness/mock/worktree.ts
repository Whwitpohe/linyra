// Dev-only: the Log's Uncommitted side, built from mock work with the host's own model, as
// logView.workRows() builds it. Neutral names only (CLAUDE.md constraint 3).
import type { HostMessage, WorkRow } from "../../../src/protocol";
import type { FileChange, Repo } from "../../../src/types";
import { distinctPaths, editedLabel, previewLabel, tags, totals, workKinds, type RepoWork } from "../../../src/uncommittedModel";
import type { BranchStatus } from "../../../src/workingTree";

const f = (path: string, status: FileChange["status"], added: number | null = 1, deleted: number | null = 0, extra: Partial<FileChange> = {}): FileChange => ({ path, status, added, deleted, ...extra });
const news = (dir: string, n: number) => Array.from({ length: n }, (_, i) => f(`${dir}/page-${String(i + 1).padStart(3, "0")}.md`, "A", 0, 0, { untracked: true }));
const MIN = 60_000;

/** Each repository's work: a branch in every state the pill draws (the "adjacent" scenario lists them all). */
const WORK: Record<string, { branch: BranchStatus; staged: FileChange[]; changes: FileChange[]; ago: number; head?: string }> = {
  "acme-web": { branch: { name: "develop", upstream: "origin/develop", ahead: 1, behind: 2 }, ago: 2 * MIN,
    staged: [f("notes.md", "M", 1, 0)], changes: [f("src/app.ts", "M", 12, 3), f("src/new.ts", "A", 0, 0, { untracked: true }), f("notes.md", "M", 2, 0)] },
  "acme-api": { branch: { name: "main", upstream: "origin/main", ahead: 0, behind: 0 }, ago: 60 * MIN, staged: [], changes: [f("upload/upload.go", "M", 7, 1)] },
  "acme-libs": { branch: { name: "feature/button", upstream: null, ahead: 0, behind: 0 }, ago: 180 * MIN, staged: [f("ui/Button.tsx", "D", 0, 40)], changes: [] },
  "acme-docs": { branch: { name: "main", upstream: "origin/main", ahead: 0, behind: 3 }, ago: 26 * 60 * MIN,
    staged: [], changes: [f("guide/setup.md", "M", 4, 4), f("guide/old.md", "D", 0, 9), f("guide/faq.md", "M", 1, 1), ...news("guide/new", 143)] },
  "acme-infra": { branch: { name: null, upstream: null, ahead: 0, behind: 0 }, head: "4f2a9c1e".padEnd(40, "0"), ago: 5 * MIN, staged: [], changes: [f("deploy/values.yaml", "M", 2, 2)] },
  "acme-worker": { branch: { name: "release-1.4", upstream: "origin/release-1.4", ahead: 0, behind: 0, gone: true }, ago: 3 * 24 * 60 * MIN,
    staged: [f("jobs/retry.ts", "R", 0, 0, { oldPath: "jobs/backoff.ts" })], changes: [f("jobs/queue.ts", "M", 3, 0)] },
};

/** The "uncommitted" message for the repositories the harness lists. */
export function mockWork(repos: readonly Repo[], nowSeconds: number): Extract<HostMessage, { type: "uncommitted" }> {
  const now = nowSeconds * 1000;
  const works: RepoWork[] = repos.flatMap((r) => {
    const w = WORK[r.name];
    return w ? [{ repoId: r.id, root: r.root, name: r.name, head: w.head ?? "a".repeat(40), branch: w.branch, staged: w.staged, changes: w.changes, editedAt: now - w.ago, canStage: true }] : [];
  });
  const rows: WorkRow[] = works.filter((w) => distinctPaths(w).length > 0)
    .sort((a, b) => (b.editedAt ?? -Infinity) - (a.editedAt ?? -Infinity))
    .map((w) => ({ repoId: w.repoId, preview: previewLabel(w), counts: workKinds(w), ...(w.branch ? { branch: w.branch } : {}), head: w.head, tags: tags(w),
      edited: editedLabel(now, w.editedAt), canStage: w.canStage, hasStaged: w.staged.length > 0, hasChanges: w.changes.length > 0 }));
  return { type: "uncommitted", known: true, totals: totals(works), rows };
}
