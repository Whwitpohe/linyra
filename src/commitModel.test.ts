import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { branchLine, branchText, checkedLabel, checkOnly, commitFiles, commitPartly, conflictsBlocking, countsLine, commitPlan, describeCommit, fileKey, filesUnder, ignoreLine, pruneChoices, mdText, rowsById, setChecked, withIgnored, type CommitRow } from "./commitModel";
import { gitEnv, makeRepo } from "./fixtures";
import { runGit } from "./git";
import type { FileChange } from "./types";
import type { RepoWork } from "./uncommittedModel";
import { gitWithPaths, headOf, parseNumstat, splitStatus, stagedNumstatArgs, statusArgs, unstagedNumstatArgs, workFiles } from "./workingTree";

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
  assert.match(byId.get("changes:/ws/acme-api")!.tooltip, /Discard Changes needs VS Code's Git/, "a repository VS Code's Git does not have open says why Discard Changes does nothing");
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

{
  // A conflicted file is never committed: in a stopped merge none may be left (the commit takes the index), elsewhere none checked.
  const plan = { paths: ["src/app.ts", "notes.md"] };
  assert.strictEqual(conflictsBlocking(plan, ["src/app.ts"], false), 1, "checked and conflicted");
  assert.strictEqual(conflictsBlocking(plan, ["old.css"], false), 0, "conflicted, not checked: git commit --only leaves it out");
  assert.strictEqual(conflictsBlocking(plan, ["old.css"], true), 1, "a merge's commit takes the index: any conflict stops it");
  assert.strictEqual(conflictsBlocking(plan, [], true), 0);
  console.log("ok - a commit refuses a checked file still conflicted, and in a merge any");
}

{
  // A staged rename takes its old name along, to record the move; never a copy's source, nor a new file made at the old name.
  const renamed: RepoWork = { ...web, staged: [f("b.txt", "R", { oldPath: "a.txt" })], changes: [f("a.txt", "A", { untracked: true })] };
  assert.strictEqual(commitFiles(renamed).find((x) => x.path === "b.txt")?.oldPath, "a.txt", "still shown as the rename");
  assert.deepStrictEqual(commitPlan([renamed], new Map())[0].paths, ["b.txt"], "the new a.txt is unchecked: it stays out");
  assert.deepStrictEqual(commitPlan([renamed], new Map([[fileKey(web.repoId, "a.txt"), true]]))[0].paths, ["a.txt", "b.txt"], "checked, it goes in as itself");
  const copied: RepoWork = { ...web, staged: [f("copy.txt", "C", { oldPath: "src.txt" }), f("src.txt", "M")], changes: [] };
  assert.deepStrictEqual(commitPlan([copied], new Map([[fileKey(web.repoId, "src.txt"), false]]))[0].paths, ["copy.txt"], "a copy's source, unchecked, keeps its staged edit out");
  assert.deepStrictEqual(commitPlan([{ ...copied, staged: [copied.staged[0]] }], new Map())[0].paths, ["copy.txt"], "a copy never takes its source");
  console.log("ok - a rename's old name goes with it, a copy's source and a new file at the old name only when checked");
}

void (async () => {
  // Real git: what the Commit side bar plans, read as the store reads a repository.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-commit-test-"));
  Object.assign(process.env, gitEnv(home), { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" });
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: process.env, encoding: "utf8", stdio: "pipe" });
  const read = async (root: string): Promise<RepoWork> => {
    const out = await runGit(root, statusArgs([]));
    const split = splitStatus(out);
    const head = headOf(out);
    const staged = workFiles(split.staged, parseNumstat(split.staged.length > 0 ? await runGit(root, stagedNumstatArgs(head, [])) : ""));
    const changes = workFiles(split.changes, parseNumstat(split.changes.length > 0 ? await runGit(root, unstagedNumstatArgs([])) : ""));
    return { repoId: root, root, name: path.basename(root), head, staged, changes, editedAt: null, canStage: true };
  };
  const unmerged = async (root: string) => (await runGit(root, ["diff", "--name-only", "-z", "--diff-filter=U", "--"])).split("\0").filter(Boolean);
  try {
    // A stash pop that conflicted: no merge, cherry-pick or revert, the file checked as any change is.
    const web = path.join(home, "acme-web");
    makeRepo(web, [{ time: 1000, author: "dana", message: "feat: base", files: { "f.txt": "base\n", "other.txt": "o\n" } }], home);
    fs.writeFileSync(path.join(web, "f.txt"), "stashed\n");
    git(web, ["stash", "-q"]);
    fs.writeFileSync(path.join(web, "f.txt"), "head\n");
    git(web, ["commit", "-qam", "feat: head"]);
    assert.throws(() => git(web, ["stash", "pop"]), "the pop stops on the conflict");
    fs.writeFileSync(path.join(web, "other.txt"), "o2\n");
    const w = await read(web);
    const [plan] = commitPlan([w], new Map());
    assert.deepStrictEqual(plan.paths, ["f.txt", "other.txt"], "the conflicted file is checked by default");
    assert.strictEqual(conflictsBlocking(plan, await unmerged(web), false), 1, "so Commit refuses it");
    const [rest] = commitPlan([w], new Map([[fileKey(web, "f.txt"), false]]));
    assert.strictEqual(conflictsBlocking(rest, await unmerged(web), false), 0, "unchecked, the other file commits");
    await gitWithPaths(runGit, web, rest.paths, ["commit", "--only", "--file=-"], { input: "fix: other" });
    assert.match(git(web, ["show", "HEAD:f.txt"]), /^head\n$/, "no conflict marker committed");
    console.log("ok - real git: after a stash pop that conflicted, the conflicted file is refused and the others commit");

    const api = path.join(home, "acme-api");
    const eight = "1\n2\n3\n4\n5\n6\n7\n8\n";
    const source = eight.replace(/\d/g, "s$&");
    makeRepo(api, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": eight, "src.txt": source } }], home);
    const commit = async (paths: readonly string[], message: string) => gitWithPaths(runGit, api, paths, ["commit", "--only", "--file=-"], { input: message });
    const shown = () => git(api, ["show", "--name-status", "-z", "--format=", "-M", "HEAD"]).split("\0").filter(Boolean);
    // A rename alone: its old name goes with it, and the commit records the move.
    git(api, ["mv", "a.txt", "b.txt"]);
    const [moved] = commitPlan([await read(api)], new Map());
    assert.deepStrictEqual(moved.paths, ["b.txt", "a.txt"]);
    await commit(moved.paths, "refactor: b");
    assert.deepStrictEqual(shown(), ["R100", "a.txt", "b.txt"]);
    // A rename, then a new file at the old name, unchecked: the new file is not committed.
    git(api, ["mv", "b.txt", "c.txt"]);
    fs.writeFileSync(path.join(api, "b.txt"), "new b\n");
    const [past] = commitPlan([await read(api)], new Map());
    assert.deepStrictEqual(past.paths, ["c.txt"]);
    await commit(past.paths, "refactor: c");
    assert.strictEqual(git(api, ["show", "HEAD:b.txt"]), eight, "b.txt as it was: the unchecked new file stays out");
    assert.match(git(api, ["status", "--porcelain"]), /^\?\? b\.txt$/m, "and stays on disk, new");
    // A copy (diff.renames=copies), its source's staged edit unchecked: the copy alone.
    git(api, ["config", "diff.renames", "copies"]);
    fs.copyFileSync(path.join(api, "src.txt"), path.join(api, "copy.txt"));
    fs.writeFileSync(path.join(api, "src.txt"), source.replace("s8\n", "edit\n"));
    git(api, ["add", "src.txt", "copy.txt"]);
    const copied = await read(api);
    assert.strictEqual(copied.staged.find((x) => x.path === "copy.txt")?.status, "C", "git status reports the copy");
    const [copy] = commitPlan([copied], new Map([[fileKey(api, "src.txt"), false], [fileKey(api, "b.txt"), false]]));
    assert.deepStrictEqual(copy.paths, ["copy.txt"]);
    await commit(copy.paths, "feat: copy");
    assert.strictEqual(git(api, ["show", "HEAD:src.txt"]), source, "the source's edit is not committed");
    assert.match(git(api, ["status", "--porcelain"]), /^M  src\.txt$/m, "it stays staged");
    console.log("ok - real git: a rename commits with its old name, never a new file there, nor a copy's source");

    // Renamed in the working tree only (mv, then git add -N): a rename, committed with its old name.
    const libs = path.join(home, "acme-libs");
    makeRepo(libs, [{ time: 1000, author: "dana", message: "feat: base", files: { "old.txt": eight } }], home);
    fs.renameSync(path.join(libs, "old.txt"), path.join(libs, "new.txt"));
    git(libs, ["add", "-N", "new.txt"]);
    const ita = await read(libs);
    assert.deepStrictEqual(commitFiles(ita).map((x) => [x.path, x.status, x.oldPath]), [["new.txt", "R", "old.txt"]], "one row, the rename");
    const [here] = commitPlan([ita], new Map());
    assert.deepStrictEqual(here.paths, ["new.txt", "old.txt"]);
    await gitWithPaths(runGit, libs, here.paths, ["commit", "--only", "--file=-"], { input: "refactor: new" });
    assert.deepStrictEqual(git(libs, ["show", "--name-status", "-z", "--format=", "-M", "HEAD"]).split("\0").filter(Boolean), ["R100", "old.txt", "new.txt"]);
    assert.strictEqual(git(libs, ["status", "--porcelain"]), "", "no deletion of old.txt left behind");
    console.log("ok - real git: a rename in the working tree only commits as a rename");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
