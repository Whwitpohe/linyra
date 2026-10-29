import * as assert from "assert";
import { DEFAULT_FILTER } from "./filterModel";
import { folderFilter, historyWorkOf, revisionPair } from "./historyModel";
import type { Commit, FileChange } from "./types";
import type { RepoWork } from "./uncommittedModel";

const work = (staged: FileChange[], changes: FileChange[]): RepoWork => ({ repoId: "/work/acme-web", root: "/work/acme-web", name: "acme-web", head: "a".repeat(40), staged, changes, editedAt: null, canStage: true });
const f = (path: string, added: number | null, deleted: number | null, extra: Partial<FileChange> = {}): FileChange => ({ path, added, deleted, status: "M", ...extra });

// ── The uncommitted row: from the store's work, no git process ─────────────
{
  assert.strictEqual(historyWorkOf(undefined, "src/client.ts"), null, "a repository with no work read has no row");
  assert.strictEqual(historyWorkOf(work([], [f("src/other.ts", 1, 0)]), "src/client.ts"), null, "another file's change is not this file's");
  assert.deepStrictEqual(historyWorkOf(work([], [f("src/client.ts", 4, 2)]), "src/client.ts"),
    { path: "src/client.ts", status: "M", untracked: false, staged: false, partlyStaged: false, added: 4, deleted: 2 });
  assert.deepStrictEqual(historyWorkOf(work([f("src/client.ts", 10, 0, { status: "A" })], [f("src/client.ts", 2, 1)]), "src/client.ts"),
    { path: "src/client.ts", status: "A", untracked: false, staged: true, partlyStaged: true, added: 12, deleted: 1 }, "staged new, changed again: still new, both halves' lines");
  assert.strictEqual(historyWorkOf(work([f("src/client.ts", 1, 0)], [f("src/client.ts", 0, 9, { status: "D" })]), "src/client.ts")?.status, "D", "deleted after staging: the commit deletes it");
  assert.deepStrictEqual(historyWorkOf(work([], [f("notes.md", 3, 0, { status: "A", untracked: true })]), "notes.md"),
    { path: "notes.md", status: "A", untracked: true, staged: false, partlyStaged: false, added: 3, deleted: 0 }, "a new file is added (A), whatever git called it");
  assert.strictEqual(historyWorkOf(work([], [f("logo.png", null, null)]), "logo.png")?.added, null, "binary: no line counts");
  assert.deepStrictEqual(historyWorkOf(work([f("src/api.ts", 1, 1, { status: "R", oldPath: "src/client.ts" })], []), "src/client.ts"),
    { path: "src/api.ts", oldPath: "src/client.ts", status: "R", untracked: false, staged: true, partlyStaged: false, added: 1, deleted: 1 }, "a staged rename belongs to the file's history under either name");
  console.log("ok - File History's uncommitted row comes from the uncommitted store's work");
}

// ── Two selected rows: the file at the older one, then at the newer one ────
{
  const row = (sha: string, file: Commit["file"]): Commit => ({ repoId: "/work/acme-web", sha: sha.repeat(40), time: 0, author: "dana", email: "dana@example.com", subject: "", parents: [], file });
  assert.deepStrictEqual(revisionPair([row("b", { path: "src/api.ts", status: "M" }), row("a", { path: "src/client.ts", status: "M" })]),
    { before: { ref: "a".repeat(40), path: "src/client.ts" }, after: { ref: "b".repeat(40), path: "src/api.ts" } }, "each side under the name the file had then");
  assert.deepStrictEqual(revisionPair([row("b", { path: "x.ts", status: "D" }), row("a", { path: "x.ts", status: "A" })]),
    { before: { ref: "a".repeat(40), path: "x.ts" }, after: { ref: null, path: "x.ts" } }, "a row that deleted the file shows nothing on its side");
  assert.strictEqual(revisionPair([row("b", undefined), row("a", { path: "x.ts" })]), undefined);
  console.log("ok - two File History rows compare the file between their revisions");
}

// ── Folder History: the Log's Path filter, for one repository, all time ────
{
  const before = { ...DEFAULT_FILTER, text: "retry", author: "rin", mine: true, authors: ["dana"], branches: ["origin/release-1.4"], sort: "topo" as const };
  const f2 = folderFilter(before, "/work/acme-web", "src/webview");
  assert.deepStrictEqual([f2.path, f2.repoIds, f2.date, f2.text, f2.author, f2.mine, f2.authors], ["src/webview", ["/work/acme-web"], "all", "", "", false, undefined]);
  assert.deepStrictEqual([f2.branches, f2.sort], [["origin/release-1.4"], "topo"], "the branch selection and the order stay");
  console.log("ok - Folder History sets the Path filter, its repository and all time");
}
