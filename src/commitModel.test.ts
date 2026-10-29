import * as assert from "assert";
import { checkedLabel, commitFiles, commitPlan, describeCommit, fileKey, filesUnder, pruneChoices, rowsById, setChecked, type CommitRow } from "./commitModel";
import type { FileChange } from "./types";
import type { RepoWork } from "./uncommittedModel";

const f = (path: string, status: FileChange["status"], extra: Partial<FileChange> = {}): FileChange => ({ path, status, added: 1, deleted: 0, ...extra });
const web: RepoWork = {
  repoId: "/ws/acme-web", root: "/ws/acme-web", name: "acme-web", head: "a".repeat(40), editedAt: null, canStage: true,
  staged: [f("notes.md", "M"), f("src/b2.ts", "R", { oldPath: "src/b.ts" })],
  changes: [f("src/app.ts", "M"), f("notes.md", "M"), f("todo.txt", "A", { untracked: true }), f("old.css", "D")],
};
const api: RepoWork = { repoId: "/ws/acme-api", root: "/ws/acme-api", name: "acme-api", head: "b".repeat(40), editedAt: null, canStage: false, staged: [], changes: [f("upload/upload.go", "M")] };
const clean: RepoWork = { ...api, repoId: "/ws/acme-libs", root: "/ws/acme-libs", name: "acme-libs", changes: [] };
const outline = (rows: readonly CommitRow[], depth = 0): string[] => rows.flatMap((r) => [`${"  ".repeat(depth)}${r.check === "on" ? "[x]" : r.check === "mixed" ? "[-]" : "[ ]"} ${r.label}${r.description ? ` | ${r.description}` : ""}`, ...outline(r.children ?? [], depth + 1)]);

{
  const files = commitFiles(web);
  assert.deepStrictEqual(files.map((x) => x.path), ["notes.md", "old.css", "src/app.ts", "src/b2.ts", "todo.txt"], "each path once, sorted");
  assert.deepStrictEqual(files.find((x) => x.path === "notes.md"), { path: "notes.md", status: "M", untracked: false, staged: true, changed: true }, "staged and changed again: one row");
  assert.strictEqual(files.find((x) => x.path === "src/b2.ts")?.oldPath, "src/b.ts", "a staged rename keeps its old name");
  assert.strictEqual(commitFiles({ ...web, staged: [f("x.ts", "A")], changes: [f("x.ts", "D")] })[0].status, "D", "staged, then deleted: the commit deletes it");
  console.log("ok - the Commit side bar: one row per path, staged and unstaged halves merged");
}

{
  const d = describeCommit([web, api, clean], new Map(), new Map([["/ws/acme-api", 3]]));
  assert.deepStrictEqual(outline(d.roots), [
    "[x] Changes | 5 files",
    "  [x] acme-web | 4 files",
    "    [x] src | 2",
    "      [x] app.ts",
    "      [x] b2.ts | ← src/b.ts",
    "    [x] notes.md",
    "    [x] old.css",
    "  [x] acme-api | 1 file",
    "    [x] upload | 1",
    "      [x] upload.go",
    "[ ] Unversioned Files | 1 file",
    "  [ ] acme-web | 1 file",
    "    [ ] todo.txt",
  ], "Changes, then Unversioned Files, by repository and folder; new files unchecked; clean repositories left out");
  assert.deepStrictEqual(d.checked, { files: 5, repos: 2 });
  assert.strictEqual(d.total, 6);
  assert.strictEqual(d.message, undefined);
  const byId = rowsById(d.roots);
  assert.strictEqual(byId.get("changes:/ws/acme-api")?.accent, 3, "a repository row has its Log color");
  const notes = byId.get("changes:/ws/acme-web:f:notes.md")!;
  assert.deepStrictEqual([notes.kind, notes.repoId, notes.path, notes.group, notes.contextValue], ["file", "/ws/acme-web", "notes.md", "changes", "commitFile.changed"],
    "a file row is what Open File and File History take: the working tree's half");
  assert.strictEqual(byId.get("changes:/ws/acme-web:f:src/b2.ts")?.group, "staged", "only staged: the staged half");
  assert.strictEqual(byId.get("changes:/ws/acme-web:f:old.css")?.contextValue, "commitFile.deleted");
  assert.strictEqual(byId.get("unversioned:/ws/acme-web:f:todo.txt")?.contextValue, "commitFile.untracked");
  assert.strictEqual(describeCommit([api], new Map(), new Map(), () => true).roots[0].children![0].contextValue, "commitRepo.behind", "a repository behind its upstream offers Pull");
  assert.match(byId.get("changes:/ws/acme-web:f:notes.md")!.tooltip, /partly staged/);
  assert.match(byId.get("changes:/ws/acme-api")!.tooltip, /Rollback needs VS Code's Git/, "a repository VS Code's Git does not have open says why Rollback does nothing");
  assert.strictEqual(describeCommit([clean], new Map()).message, "No uncommitted changes in the ticked repositories.");
  console.log("ok - the Commit side bar's tree: lists, repositories, folders, files, checks, menus");
}

{
  const works = [web, api];
  let choices = new Map<string, boolean>();
  const rows = () => rowsById(describeCommit(works, choices).roots);
  choices = setChecked(works, choices, [rows().get("changes:/ws/acme-web:d:src")!], false);
  assert.deepStrictEqual([...choices.keys()], [fileKey("/ws/acme-web", "src/app.ts"), fileKey("/ws/acme-web", "src/b2.ts")], "a folder unchecks its files");
  assert.strictEqual(rows().get("changes:/ws/acme-web")!.check, "mixed", "some files of a repository: mixed");
  assert.strictEqual(rows().get("changes:/ws/acme-web")!.description, "2 of 4 files checked", "a checkbox has no third state: the description says how many");
  assert.strictEqual(rows().get("changes")!.check, "mixed");
  assert.strictEqual(rows().get("changes:/ws/acme-web:d:src")!.description, "2", "an unchecked folder still counts its files");
  choices = setChecked(works, choices, [rows().get("unversioned")!], true);
  assert.strictEqual(choices.get(fileKey("/ws/acme-web", "todo.txt")), true, "checking a new file is a choice");
  choices = setChecked(works, choices, [rows().get("changes:/ws/acme-web:d:src")!], true);
  assert.deepStrictEqual([...choices.keys()], [fileKey("/ws/acme-web", "todo.txt")], "back to the default: no choice kept");
  assert.deepStrictEqual(commitPlan(works, choices), [
    { repoId: "/ws/acme-web", name: "acme-web", root: "/ws/acme-web", files: 5, paths: ["notes.md", "old.css", "src/app.ts", "src/b2.ts", "src/b.ts", "todo.txt"], add: ["todo.txt"] },
    { repoId: "/ws/acme-api", name: "acme-api", root: "/ws/acme-api", files: 1, paths: ["upload/upload.go"], add: [] },
  ], "one commit per repository: checked paths, a rename's old name, new files added first");
  choices = setChecked(works, choices, [rows().get("changes:/ws/acme-api")!], false);
  assert.deepStrictEqual(commitPlan(works, choices).map((p) => p.name), ["acme-web"], "no checked files: no commit there");
  assert.deepStrictEqual(pruneChoices([{ ...web, changes: [] }], choices), new Map(), "a file no longer listed forgets its choice");
  assert.deepStrictEqual(filesUnder([rows().get("changes:/ws/acme-web:d:src")!, rows().get("changes:/ws/acme-web:f:src/app.ts")!]),
    [{ repoId: "/ws/acme-web", path: "src/app.ts" }, { repoId: "/ws/acme-web", path: "src/b2.ts" }], "a file under a selected folder counts once");
  console.log("ok - checks: folders and lists check their files, only non-default choices kept, the plan per repository");
}

{
  assert.strictEqual(checkedLabel({ files: 0, repos: 0 }), "No files checked");
  assert.strictEqual(checkedLabel({ files: 1, repos: 1 }), "1 file checked");
  assert.strictEqual(checkedLabel({ files: 3, repos: 2 }), "3 files checked in 2 repositories");
  console.log("ok - the line under the Commit button says what it takes");
}
