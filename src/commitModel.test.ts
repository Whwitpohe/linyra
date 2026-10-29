import * as assert from "assert";
import { branchLine, branchText, checkedLabel, checkOnly, commitFiles, commitPartly, countsLine, commitPlan, describeCommit, fileKey, filesUnder, ignoreLine, pruneChoices, mdText, rowsById, setChecked, withIgnored, type CommitRow } from "./commitModel";
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
  assert.deepStrictEqual(["unversioned", "unversioned:/ws/acme-web"].map((id) => byId.get(id)?.contextValue), ["commitList.unversioned", "commitRepo.unversioned"], "new files' rows offer Add to VCS");
  assert.match(byId.get("unversioned")!.tooltip, /check them to add them with the commit, or Add to VCS/, "how a new file gets into version control");
  assert.match(byId.get("changes:/ws/acme-web:f:notes.md")!.tooltip, /partly staged/);
  assert.match(byId.get("changes:/ws/acme-api")!.tooltip, /Rollback needs VS Code's Git/, "a repository VS Code's Git does not have open says why Rollback does nothing");
  assert.strictEqual(describeCommit([clean], new Map()).message, "No uncommitted changes in the ticked repositories.");
  console.log("ok - the Commit side bar's tree: lists, repositories, folders, files, checks, menus");
}

{
  // An added file, and the rows above it, offer Remove from VCS; its own row offers no Rollback.
  const added = describeCommit([{ ...web, staged: [...web.staged, f("src/new.ts", "A")] }], new Map());
  const byId = rowsById(added.roots);
  assert.deepStrictEqual(["changes", "changes:/ws/acme-web", "changes:/ws/acme-web:d:src", "changes:/ws/acme-web:f:src/new.ts", "changes:/ws/acme-web:f:src/app.ts"].map((id) => byId.get(id)?.contextValue),
    ["commitList.added", "commitRepo.added", "commitFolder.added", "commitFile.added", "commitFile.changed"]);
  // Group By: no directories, no repositories, or neither.
  assert.deepStrictEqual(outline(describeCommit([web, api], new Map(), new Map(), () => false, { repo: true, dir: false }).roots), [
    "[x] Changes | 5 files",
    "  [x] acme-web | 4 files",
    "    [x] notes.md",
    "    [x] old.css",
    "    [x] app.ts | src",
    "    [x] b2.ts | src · ← src/b.ts",
    "  [x] acme-api | 1 file",
    "    [x] upload.go | upload",
    "[ ] Unversioned Files | 1 file",
    "  [ ] acme-web | 1 file",
    "    [ ] todo.txt",
  ], "flat: each file's folder beside it");
  assert.deepStrictEqual(outline(describeCommit([web, api], new Map(), new Map(), () => false, { repo: false, dir: true }).roots), [
    "[x] Changes | 5 files",
    "  [x] src | acme-web · 2",
    "    [x] app.ts",
    "    [x] b2.ts | ← src/b.ts",
    "  [x] notes.md | acme-web",
    "  [x] old.css | acme-web",
    "  [x] upload | acme-api · 1",
    "    [x] upload.go",
    "[ ] Unversioned Files | 1 file",
    "  [ ] todo.txt | acme-web",
  ], "without repository rows, each repository's top rows name it");
  const neither = describeCommit([web, api], new Map(), new Map(), () => false, { repo: false, dir: false });
  assert.deepStrictEqual(outline(neither.roots).slice(0, 3), ["[x] Changes | 5 files", "  [x] notes.md | acme-web", "  [x] old.css | acme-web"]);
  assert.ok(rowsById(neither.roots).has("changes:/ws/acme-web:f:src/app.ts"), "a file's row id is the same however it is grouped");
  // Add to .gitignore: anchored lines, wildcards escaped, appended once in the file's own line ending.
  assert.strictEqual(ignoreLine("build/out.log", false), "/build/out.log");
  assert.strictEqual(ignoreLine("dist", true), "/dist/");
  assert.strictEqual(ignoreLine("logs/a*b?[1].txt ", false), "/logs/a\\*b\\?\\[1].txt\\ ");
  assert.strictEqual(withIgnored("", ["/dist/"]), "/dist/\n");
  assert.strictEqual(withIgnored("node_modules/", ["/dist/", "/dist/"]), "node_modules/\n/dist/\n");
  assert.strictEqual(withIgnored("node_modules/\r\n", ["/dist/"]), "node_modules/\r\n/dist/\r\n");
  assert.strictEqual(withIgnored("/dist/\n", ["/dist/"]), undefined, "already ignored: the file is left alone");
  console.log("ok - Remove from VCS on added files; Group By repository and directory; Add to .gitignore lines");
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

{
  // The branch from the same git status: on the repository row, in its tooltip, and in the list's.
  const develop = { ...web, branch: { name: "develop", upstream: "origin/develop", ahead: 1, behind: 0 } };
  const main = { ...api, branch: { name: "main", upstream: "origin/main", ahead: 0, behind: 0 } };
  const d = describeCommit([develop, main], new Map());
  const byId = rowsById(d.roots);
  assert.deepStrictEqual(outline(d.roots).filter((l) => /acme-/.test(l)).map((l) => l.trim()), [
    "[x] acme-web | develop ↑1 · 4 files", "[x] acme-api | main · 1 file", "[ ] acme-web | develop ↑1 · 1 file",
  ], "the repository row: its branch, how far from its upstream, then the files");
  const repo = byId.get("changes:/ws/acme-web")!;
  assert.strictEqual(repo.markdown, true);
  assert.strictEqual(repo.tooltip, "/ws/acme\\-web\n\n$(git-branch) develop · $(cloud) origin/develop · ↑1\n\n$(edit) 2&nbsp;&nbsp;$(diff-removed) 1&nbsp;&nbsp;$(diff-renamed) 1",
    "where it is, the branch and its upstream, the files by kind: theme icons, names escaped");
  assert.strictEqual(byId.get("changes:/ws/acme-api")!.tooltip.split("\n\n")[1], "$(git-branch) main · $(cloud) origin/main", "in step: no arrows");
  assert.strictEqual(byId.get("unversioned:/ws/acme-web")!.tooltip.split("\n\n")[2], "$(diff-added) 1", "new files are added files");
  const changes = byId.get("changes")!;
  assert.deepStrictEqual(changes.icon, { id: "diff-modified", color: "gitDecoration.modifiedResourceForeground" });
  assert.deepStrictEqual(byId.get("unversioned")!.icon, { id: "diff-added", color: "gitDecoration.untrackedResourceForeground" }, "the lists in Source Control's colors");
  assert.strictEqual(changes.tooltip, "Changes\n\n**acme\\-web** · $(git-branch) develop · $(cloud) origin/develop · ↑1\n\n**acme\\-api** · $(git-branch) main · $(cloud) origin/main\n\n$(edit) 3&nbsp;&nbsp;$(diff-removed) 1&nbsp;&nbsp;$(diff-renamed) 1",
    "a list: each repository's branch, then its files by kind, summed");
  assert.ok(byId.get("unversioned")!.tooltip.startsWith("New files: check them to add them with the commit, or Add to VCS \\(Ctrl\\+Alt\\+A\\) to add them now."));
  assert.strictEqual(byId.get("changes:/ws/acme-web:f:notes.md")!.markdown, undefined, "file rows keep plain tooltips");
  // Without repository rows, the list still names each repository's branch.
  assert.ok(rowsById(describeCommit([develop, main], new Map(), new Map(), () => false, { repo: false, dir: true }).roots).get("changes")!.tooltip.includes("**acme\\-api** · $(git-branch) main"));
  const many = Array.from({ length: 12 }, (_, i) => ({ ...main, repoId: `/ws/acme-svc-${i}`, root: `/ws/acme-svc-${i}`, name: `acme-svc-${i}` }));
  assert.match(rowsById(describeCommit(many, new Map()).roots).get("changes")!.tooltip, /\*\*acme\\-svc\\-9\*\* · [^\n]+\n\nand 2 more\n\n\$\(edit\) 12$/, "ten repositories at most, then how many more");
  console.log("ok - the Commit side bar shows each repository's branch: its row, its tooltip and its list's, with Source Control's icons");
}

{
  const w = (branch: RepoWork["branch"], head: string | null = "4f2a9c1e".padEnd(40, "0")): RepoWork => ({ ...web, head, branch });
  assert.strictEqual(branchText(w(undefined)), "", "not read by git (a clean repository): nothing");
  assert.strictEqual(branchText(w({ name: "develop", upstream: "origin/develop", ahead: 1, behind: 2 })), "develop ↑1 ↓2");
  assert.strictEqual(branchText(w({ name: "develop", upstream: null, ahead: 0, behind: 0 })), "develop");
  assert.strictEqual(branchText(w({ name: null, upstream: null, ahead: 0, behind: 0 })), "HEAD detached at 4f2a9c1");
  assert.strictEqual(branchLine(w({ name: "feature/x", upstream: null, ahead: 0, behind: 0 })), "$(git-branch) feature/x · $(cloud-upload) unpublished");
  assert.strictEqual(branchLine(w({ name: "release-1.4", upstream: "origin/release-1.4", ahead: 0, behind: 0, gone: true })), "$(git-branch) release\\-1.4 · $(cloud) origin/release\\-1.4 · gone");
  assert.strictEqual(branchLine(w({ name: "main", upstream: "origin/main", ahead: 0, behind: 0, uncounted: true })), "$(git-branch) main · $(cloud) origin/main · differs");
  assert.strictEqual(branchLine(w({ name: null, upstream: null, ahead: 0, behind: 0 }, null)), "$(git-commit) HEAD detached at HEAD");
  assert.strictEqual(branchLine(w({ name: "x_$(alert)*", upstream: null, ahead: 0, behind: 0 })).split(" · ")[0], "$(git-branch) x\\_\\$\\(alert\\)\\*", "a name never becomes an icon or emphasis");
  assert.strictEqual(mdText("a [b](c) <d> #e"), "a \\[b\\]\\(c\\) \\<d\\> \\#e");
  assert.strictEqual(countsLine({ added: 143, modified: 3, deleted: 0, renamed: 0 }), "$(edit) 3&nbsp;&nbsp;$(diff-added) 143");
  assert.strictEqual(countsLine({ added: 0, modified: 0, deleted: 0, renamed: 0 }), "");
  console.log("ok - branch text and tooltip lines: unpublished, gone, uncounted, detached; Markdown escaped");
}

{
  // Commit… on acme-web: its tracked files checked (its new file not, as the side bar's default), acme-api's unchecked.
  const only = checkOnly([web, api], web.repoId);
  assert.deepStrictEqual(commitPlan([web, api], only).map((p) => [p.name, p.paths.sort()]), [["acme-web", ["notes.md", "old.css", "src/app.ts", "src/b.ts", "src/b2.ts"]]]);
  // A repository with only new files: those are checked, or Commit… would check nothing.
  const fresh: RepoWork = { ...api, repoId: "/ws/acme-new", name: "acme-new", changes: [f("a.md", "A", { untracked: true })] };
  assert.deepStrictEqual(commitPlan([web, fresh], checkOnly([web, fresh], fresh.repoId)).map((p) => [p.name, p.add]), [["acme-new", ["a.md"]]]);
  assert.strictEqual(commitPartly(["acme-web"], [{ name: "acme-api", why: "acme hook says no" }]),
    "Committed in acme-web. Not committed in acme-api (acme hook says no). The message is kept: Commit again takes the files still checked there.");
  assert.strictEqual(commitPartly([], [{ name: "acme-api", why: "acme hook says no" }]), "Linyra could not commit: acme-api (acme hook says no). The message is kept: fix that, then Commit again.");
  console.log("ok - Commit… checks one repository's files; a partial commit names who committed, who did not, and that Commit retries");
}
