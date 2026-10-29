import * as assert from "assert";
import type { FileChange } from "./types";
import { viewLabel, commitCount, commitStep, describeUncommitted, diffFor, deletePrompt, discardPlan, discardPrompt, distinctPaths, rollbackPlan, rollbackPrompt, editedLabel, meter, NO_UNCOMMITTED_VIEW, previewLabel, tags, totals, type RepoWork, type UNode } from "./uncommittedModel";

const f = (path: string, status: FileChange["status"], added = 1, deleted = 0, extra: Partial<FileChange> = {}): FileChange => ({ path, status, added, deleted, ...extra });
const web: RepoWork = {
  repoId: "/ws/acme-web", root: "/ws/acme-web", name: "acme-web", head: "a".repeat(40), editedAt: 1_000_000, canStage: true,
  staged: [f("notes.md", "M", 1, 0)],
  changes: [f("src/app.ts", "M", 3, 1), f("src/new.ts", "A", 0, 0, { untracked: true }), f("notes.md", "M", 2, 0)],
};
const api: RepoWork = { repoId: "/ws/acme-api", root: "/ws/acme-api", name: "acme-api", head: "b".repeat(40), editedAt: null, canStage: false, staged: [], changes: [f("upload/upload.go", "M", 2, 0)] };
const clean: RepoWork = { ...api, repoId: "/ws/acme-libs", root: "/ws/acme-libs", name: "acme-libs", changes: [] };
const files = (n: UNode): UNode[] => (n.kind === "file" ? [n] : n.children.flatMap(files));

{
  assert.deepStrictEqual(distinctPaths(web), ["notes.md", "src/app.ts", "src/new.ts"], "a file in both halves counts once");
  assert.deepStrictEqual(totals([web, api, clean]), { files: 4, repos: 2, added: 8, deleted: 1 }, "clean repositories do not count");
  assert.deepStrictEqual(meter(web), { added: 1, modified: 2, deleted: 0 });
  assert.deepStrictEqual(tags(web), ["1 staged", "1 new"]);
  assert.deepStrictEqual(tags({ ...web, changes: [] }), ["all staged"]);
  assert.deepStrictEqual(tags(api), []);
  assert.strictEqual(previewLabel(web), "3 files · notes.md, src/app.ts, src/new.ts");
  assert.strictEqual(previewLabel(api), "1 file · upload/upload.go");
  assert.strictEqual(editedLabel(1_000_000 + 125_000, 1_000_000), "edited 2m ago");
  assert.strictEqual(editedLabel(1_000_000 + 20_000, 1_000_000), "edited just now");
  assert.strictEqual(editedLabel(1_000_000 + 3 * 3_600_000, 1_000_000), "edited 3h ago");
  assert.strictEqual(editedLabel(5, null), "");
  console.log("ok - the Log's Uncommitted rows: distinct files, totals, meter, tags, preview, edited time");
}
{
  const staged = f("a.ts", "M"), added = f("n.ts", "A"), untracked = f("u.ts", "A", 0, 0, { untracked: true }), gone = f("g.ts", "D");
  assert.deepStrictEqual(diffFor("staged", staged, true), { left: "head", right: "index" });
  assert.deepStrictEqual(diffFor("staged", added, true), { left: "empty", right: "index" });
  assert.deepStrictEqual(diffFor("changes", staged, true), { left: "index", right: "worktree" }, "staged and changed again: index ↔ file");
  assert.deepStrictEqual(diffFor("changes", staged, false), { left: "head", right: "worktree" });
  assert.deepStrictEqual(diffFor("changes", untracked, false), { left: "empty", right: "worktree" });
  assert.deepStrictEqual(diffFor("changes", gone, false), { left: "head", right: "empty" });
  assert.deepStrictEqual(diffFor("staged", gone, true), { left: "head", right: "empty" });
  console.log("ok - each row opens the diff Source Control would");
}
{
  assert.deepStrictEqual(discardPrompt("acme-web", [f("src/app.ts", "M")], true), { message: 'Discard changes in "src/app.ts"?', detail: "This can't be undone.", button: "Discard File" });
  assert.strictEqual(discardPrompt("acme-web", [f("src/new.ts", "A", 0, 0, { untracked: true })], true).detail, "This can't be undone. This deletes the new file.");
  assert.deepStrictEqual(discardPrompt("acme-web", web.changes, false), { message: "Discard changes in 3 files in acme-web?", detail: "This can't be undone. 1 new file will be deleted.", button: "Discard All" });
  // The whole repository: notes.md is in both groups and counts once; its staged change goes too.
  assert.deepStrictEqual(discardPrompt("acme-web", [...web.staged, ...web.changes], false, web.staged), { message: "Discard changes in 3 files in acme-web?", detail: "This can't be undone. Staged changes are discarded too. 1 new file will be deleted.", button: "Discard All" });
  // A staged new file is deleted; a staged rename unstages both names and deletes the new one.
  const added = f("src/added.ts", "A");
  assert.strictEqual(discardPrompt("acme-web", [added], true, [added]).detail, "This can't be undone. Staged changes are discarded too. This deletes the new file.");
  const moved = f("src/b.ts", "R", 0, 0, { oldPath: "src/a.ts" });
  assert.deepStrictEqual(discardPlan([moved, ...web.changes], [moved]), { paths: ["src/b.ts", "src/a.ts", "src/app.ts", "src/new.ts", "notes.md"], unstage: ["src/b.ts", "src/a.ts"], remove: ["src/b.ts", "src/new.ts"] });
  // Only the Changes half of a staged new file: it is restored to the index, not deleted.
  assert.deepStrictEqual(discardPlan([added], []).remove, []);
  // Rollback, as the JetBrains IDEs': an added file (edited since, too) leaves version control and stays.
  const addedEdited = f("src/added.ts", "M");
  assert.deepStrictEqual(rollbackPlan([added, addedEdited], [added]), { paths: [], unstage: [], remove: [], unadd: ["src/added.ts"] });
  // A rename moves back; an unversioned file is not Rollback's: Delete… removes it.
  assert.deepStrictEqual(rollbackPlan([moved, ...web.changes], [moved]), { ...discardPlan([moved, web.changes[0], web.changes[2]], [moved]), unadd: [] });
  assert.deepStrictEqual(rollbackPrompt("acme-web", [added, addedEdited], true, [added]), {
    message: 'Roll back "src/added.ts"?', detail: "The added file leaves version control and stays on disk, under Unversioned Files.", button: "Rollback",
  });
  const more = f("src/more.ts", "A");
  const mixed = rollbackPrompt("acme-web", [added, more, ...web.staged, ...web.changes], false, [added, more, ...web.staged]);
  assert.strictEqual(mixed.message, "Roll back 4 files in acme-web?", "the unversioned file is not counted");
  assert.strictEqual(mixed.detail, "This can't be undone. Staged changes are discarded too. The 2 added files leave version control and stay on disk, under Unversioned Files.");
  assert.deepStrictEqual(rollbackPrompt("acme-web", web.changes, false), { message: "Roll back 2 files in acme-web?", detail: "This can't be undone.", button: "Rollback" });
  // Delete…: its own words and button, never Rollback's.
  assert.deepStrictEqual(deletePrompt("acme-web", ["src/new.ts"], true), { message: 'Delete "src/new.ts"?', detail: "The file is deleted from disk. This can't be undone.", button: "Delete" });
  assert.deepStrictEqual(deletePrompt("2 repositories", ["a.md", "b.md", "c.md"], false), { message: "Delete 3 files in 2 repositories?", detail: "The files are deleted from disk. This can't be undone.", button: "Delete" });
  assert.strictEqual(commitStep(1, 3, false), "message");
  assert.strictEqual(commitStep(0, 3, true), "commitAll", "git.enableSmartCommit: commit everything without asking");
  assert.strictEqual(commitStep(0, 3, false), "askStageAll");
  assert.strictEqual(commitStep(0, 0, false), "nothing");
  console.log("ok - Discard's, Rollback's (an added file leaves version control and stays) and Delete's confirmations, Commit's steps");
}
{
  const d = describeUncommitted([web, api, clean]);
  assert.strictEqual(d.message, undefined);
  assert.deepStrictEqual(d.roots.map((r) => [r.label, r.description, r.contextValue]), [["acme-web", "3 files", "repo.stageable"], ["acme-api", "1 file", "repo.readonly"]], "clean repositories are not listed; review only without vscode.git");
  const groups = d.roots[0].children;
  assert.deepStrictEqual(groups.map((g) => [g.label, g.description, g.contextValue]), [["Staged", "1", "group.staged"], ["Changes", "3", "group.changes"]]);
  const src = groups[1].children.find((n) => n.label === "src")!;
  assert.strictEqual(src.contextValue, "folder.changes", "a folder offers Stage and Discard for every file under it");
  assert.strictEqual(describeUncommitted([{ ...web, staged: [], changes: [f("gone.ts", "D", 0, 4)] }]).roots[0].children[0].children[0].contextValue, "file.changes.deleted", "a deleted file: no Open File");
  assert.deepStrictEqual(src.children.map((n) => [n.label, n.description, n.contextValue]), [["app.ts", "+3 −1", "file.changes"], ["new.ts", "new", "file.changes.untracked"]]);
  assert.ok(files(d.roots[1]).every((n) => n.contextValue.endsWith(".readonly")), "no Stage/Discard on a repository vscode.git has not opened");
  assert.ok(d.roots[1].children.every((g) => g.contextValue.endsWith(".readonly")));
  assert.strictEqual(describeUncommitted([clean]).message, NO_UNCOMMITTED_VIEW);
  const ids = JSON.stringify(d.roots).match(/"id":"[^"]+"/g)!;
  assert.strictEqual(new Set(ids).size, ids.length, "ids are unique (the same path in both groups)");
  console.log("ok - the Uncommitted view: repositories, Staged/Changes groups, folders, files, read-only rows");
}
{
  // Commit all, as VS Code's smart commit: git.smartCommitChanges "tracked" leaves new files out.
  assert.strictEqual(commitCount(web, "all"), 3, "all: tracked and new files");
  assert.strictEqual(commitCount(web, "tracked"), 2, "tracked: the new file stays out");
  console.log("ok - Commit all counts what git.smartCommitChanges will commit");
}

assert.strictEqual(viewLabel({ files: 0, repos: 0 }), "");
assert.strictEqual(viewLabel({ files: 3, repos: 2 }), "3 files · 2 repositories");
assert.strictEqual(viewLabel({ files: 1, repos: 1 }), "1 file · 1 repository");
console.log("ok - the Uncommitted view's description counts files and repositories");
