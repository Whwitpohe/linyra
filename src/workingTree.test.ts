import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitEnv, makeRepo } from "./fixtures";
import { runGit } from "./git";
import { branchOf, EMPTY_TREE, gitWithPaths, headOf, parseNumstat, splitStatus, stagedNumstatArgs, statusArgs, unstagedNumstatArgs, workFiles } from "./workingTree";

// git status --porcelain=v2 -z: "1 XY sub mH mI mW hH hI path", "2 XY … Xscore path\0orig", "? path", "u XY …".
const H = "0".repeat(40);
const rec = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 ${H} ${H} ${path}`;

{
  const n = parseNumstat("3\t1\tsrc/app.ts\0-\t-\tlogo.png\0" + "2\t0\t\0docs/a.md\0docs/b.md\0");
  assert.deepStrictEqual(n.get("src/app.ts"), { added: 3, deleted: 1 });
  assert.deepStrictEqual(n.get("logo.png"), { added: null, deleted: null }, "binary");
  assert.deepStrictEqual(n.get("docs/b.md"), { added: 2, deleted: 0 }, "renames are keyed by the new name");
  console.log("ok - git diff --numstat -z gives each file's +/- counts");
}
{
  assert.deepStrictEqual(statusArgs([]), ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], "--branch: the last commit comes in the same call");
  assert.deepStrictEqual(statusArgs([":(literal)src"]), ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", ":(literal)src"], "the Path filter narrows it, after --");
  console.log("ok - status arguments");
}
{
  const withBranch = `# branch.oid ${"a".repeat(40)}\0# branch.head main\0` + rec(".M", "src/app.ts") + "\0";
  assert.strictEqual(headOf(withBranch), "a".repeat(40), "the last commit, from git status --branch");
  assert.strictEqual(headOf("# branch.oid (initial)\0# branch.head main\0"), null, "no commit yet");
  assert.deepStrictEqual(splitStatus(withBranch).changes.map((e) => e.path), ["src/app.ts"], "the # header lines are not files");
  console.log("ok - git status --branch gives the last commit too, so no separate rev-parse");
}
{
  const out = [
    rec(".M", "src/app.ts"), // changed, not staged
    rec("M.", "src/staged.ts"), // fully staged
    rec("MM", "src/both.ts"), // staged, then changed again
    rec("A.", "src/new.ts"), // added to the index
    rec("AM", "src/newer.ts"), // added, then changed again
    rec("AD", "added-then-deleted.ts"), // staged as new, then deleted from disk
    rec(".D", "old.txt"), // deleted in the working tree
    rec("D.", "gone.txt"), // git rm
    `2 R. N... 100644 100644 100644 ${H} ${H} R100 docs/b.md\0docs/a.md`,
    `2 RM N... 100644 100644 100644 ${H} ${H} R100 docs/d.md\0docs/c.md`,
    "? notes/todo café.md",
    `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.ts`,
  ].join("\0") + "\0";
  const s = splitStatus(`# branch.oid ${"a".repeat(40)}\0# branch.head main\0` + out);
  assert.deepStrictEqual(s.staged.map((e) => [e.path, e.status]), [
    ["src/staged.ts", "M"], ["src/both.ts", "M"], ["src/new.ts", "A"], ["src/newer.ts", "A"], ["added-then-deleted.ts", "A"], ["gone.txt", "D"], ["docs/b.md", "R"], ["docs/d.md", "R"],
  ], "the index half: what a commit now would contain");
  assert.deepStrictEqual(s.changes.map((e) => [e.path, e.status]), [
    ["src/app.ts", "M"], ["src/both.ts", "M"], ["src/newer.ts", "M"], ["added-then-deleted.ts", "D"], ["old.txt", "D"], ["docs/d.md", "M"], ["notes/todo café.md", "A"], ["conflict.ts", "M"],
  ], "the working-tree half, untracked and conflicted files included");
  assert.strictEqual(s.staged.find((e) => e.path === "docs/b.md")?.oldPath, "docs/a.md");
  assert.ok(s.changes.find((e) => e.path === "notes/todo café.md")?.untracked);
  assert.ok(s.changes.find((e) => e.path === "conflict.ts")?.conflicted);
  assert.deepStrictEqual(splitStatus(""), { staged: [], changes: [] });
  console.log("ok - git status splits into Staged (index) and Changes (working tree); a file can be in both");
}
{
  // mv old.txt new.txt, then git add -N new.txt: renamed in the working tree only, the old name in no other entry.
  const s = splitStatus(`2 .R N... 100644 100644 100644 ${H} ${H} R100 new.txt\0old.txt\0` + `2 RM N... 100644 100644 100644 ${H} ${H} R100 b.md\0a.md\0`);
  assert.deepStrictEqual(s.changes, [{ path: "new.txt", oldPath: "old.txt", status: "R" }, { path: "b.md", status: "M" }], "still a rename, from its old name; a staged rename's own edit is not one");
  assert.deepStrictEqual(s.staged.map((e) => [e.path, e.oldPath, e.status]), [["b.md", "a.md", "R"]]);
  console.log("ok - a rename in the working tree only keeps its old name");
}
{
  // A submodule: "S<c><m><u>", c the commit it is checked out at changed, m its tracked files, u new ones (git 2.43).
  const sub = (xy: string, s: string) => `1 ${xy} ${s} 160000 160000 160000 ${H} ${H} acme-libs`;
  const changed = (...lines: string[]) => splitStatus(lines.join("\0") + "\0").changes.map((e) => e.path);
  assert.deepStrictEqual(changed(sub(".M", "S.MU"), sub(".M", "S..U"), sub(".M", "S.M.")), [], "only its own files changed: nothing here to commit");
  assert.deepStrictEqual(changed(sub(".M", "SC.U")), ["acme-libs"], "at another commit: that is a change");
  const s = splitStatus(sub("MM", "S..U") + "\0");
  assert.deepStrictEqual([s.staged.map((e) => e.path), s.changes], [["acme-libs"], []], "its new commit staged; its new files are its own");
  console.log("ok - a submodule is a change only where its commit moved");
}
{
  // A repository inside this one, untracked: git lists it as "acme-libs/" (with --untracked-files=all too).
  const s = splitStatus(["? acme-libs/", "? acme-libs.md", "? docs/vendor/acme-api/"].join("\0") + "\0");
  assert.deepStrictEqual(s.changes.map((e) => e.path), ["acme-libs.md"], "a nested repository is not a new file to commit");
  console.log("ok - an untracked nested repository is not listed as a file");
}
{
  assert.deepStrictEqual(stagedNumstatArgs("a".repeat(40), [":(literal)src"]), ["diff", "--cached", "a".repeat(40), "--numstat", "-z", "-M", "--", ":(literal)src"]);
  assert.deepStrictEqual(stagedNumstatArgs(null, []).slice(0, 3), ["diff", "--cached", EMPTY_TREE], "no commit yet: against the empty tree");
  assert.deepStrictEqual(unstagedNumstatArgs([]), ["diff", "--numstat", "-z", "--"], "index ↔ working tree");
  const files = workFiles(splitStatus(rec(".M", "a.ts") + "\0? b.ts\0").changes, parseNumstat("3\t1\ta.ts\0"));
  assert.deepStrictEqual(files.map((f) => [f.path, f.added, f.deleted, f.status, f.untracked === true]), [["a.ts", 3, 1, "M", false], ["b.ts", 0, 0, "A", true]], "an untracked file counts 0/0: new, not binary");
  console.log("ok - Staged and Changes counts come from their own diffs");
}
{
  const I = "c".repeat(40);
  const line = `1 MM N... 100644 100644 100644 ${"0".repeat(40)} ${I} src/both.ts`;
  const s = splitStatus(line + "\0" + `2 R. N... 100644 100644 100644 ${"0".repeat(40)} ${I} R100 docs/b.md\0docs/a.md\0`);
  assert.deepStrictEqual(s.staged.map((e) => [e.path, e.blob]), [["src/both.ts", I], ["docs/b.md", I]], "each staged entry knows its index blob (the hI field)");
  assert.strictEqual(workFiles(s.staged, new Map())[0].blob, I);
  console.log("ok - the staged side keeps its index blob id");
}
{
  // The branch header, as git 2.55 prints it (recorded from real repositories).
  const OID = `# branch.oid ${"5".repeat(40)}`;
  const z = (...lines: string[]) => lines.join("\0") + "\0";
  assert.deepStrictEqual(branchOf(z(OID, "# branch.head main", "# branch.upstream origin/main", "# branch.ab +0 -0")),
    { name: "main", upstream: "origin/main", ahead: 0, behind: 0 }, "in step with its upstream");
  assert.deepStrictEqual(branchOf(z(OID, "# branch.head develop", "# branch.upstream origin/develop", "# branch.ab +1 -0")),
    { name: "develop", upstream: "origin/develop", ahead: 1, behind: 0 }, "ahead only");
  assert.deepStrictEqual(branchOf(z(OID, "# branch.head develop", "# branch.upstream origin/develop", "# branch.ab +3 -12") + rec(".M", "a.ts") + "\0"),
    { name: "develop", upstream: "origin/develop", ahead: 3, behind: 12 }, "ahead and behind, files after the header");
  assert.deepStrictEqual(branchOf(z(OID, "# branch.head local-only")), { name: "local-only", upstream: null, ahead: 0, behind: 0 }, "no upstream: never published");
  assert.deepStrictEqual(branchOf(z(OID, "# branch.head (detached)")), { name: null, upstream: null, ahead: 0, behind: 0 }, "detached HEAD: no branch");
  assert.deepStrictEqual(branchOf(z("# branch.oid (initial)", "# branch.head main")), { name: "main", upstream: null, ahead: 0, behind: 0 }, "before the first commit: the branch to be");
  assert.deepStrictEqual(branchOf(z(OID, "# branch.head feature", "# branch.upstream origin/feature")),
    { name: "feature", upstream: "origin/feature", ahead: 0, behind: 0, gone: true }, "the upstream's branch is gone: no ab line");
  assert.deepStrictEqual(branchOf(z(OID, "# branch.head main", "# branch.upstream origin/main", "# branch.ab +? -?")),
    { name: "main", upstream: "origin/main", ahead: 0, behind: 0, uncounted: true }, "--no-ahead-behind: it differs, by an unknown count");
  assert.deepStrictEqual(branchOf(`${OID}\n# branch.head main\n# branch.upstream upstream/release-1.4\n# branch.ab +0 -2\n1 .M N... x\n`),
    { name: "main", upstream: "upstream/release-1.4", ahead: 0, behind: 2 }, "without -z: one header per line");
  assert.deepStrictEqual(branchOf(z(OID, "# stash 2", "# branch.head main")), { name: "main", upstream: null, ahead: 0, behind: 0 }, "other headers (--show-stash) are skipped");
  assert.strictEqual(branchOf(rec(".M", "a.ts") + "\0"), undefined, "status without --branch: no header, nothing known");
  assert.strictEqual(branchOf(""), undefined);
  assert.strictEqual(branchOf(rec(".M", "a.ts") + "\0# branch.head evil\0"), undefined, "a header-like token after the first file is a file name, not a header");
  const renamed = `2 R. N... 100644 100644 100644 ${H} ${H} R100 new.md\0# branch.head evil`;
  assert.strictEqual(branchOf(z(OID, "# branch.head main") + renamed + "\0")?.name, "main", "a rename's old name never overrides the header");
  console.log("ok - branchOf: the branch, its upstream and the distance from git status --branch (detached, unpublished, gone, uncounted)");
}

void (async () => {
  // Real git: the paths the Commit side bar and Rollback hand to git are files, never patterns.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-paths-test-"));
  Object.assign(process.env, gitEnv(home), { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" });
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: process.env, encoding: "utf8", stdio: "pipe" });
  const names = (out: string) => out.split("\0").filter(Boolean).sort();
  try {
    const web = path.join(home, "acme-web");
    makeRepo(web, [{ time: 1000, author: "dana", message: "feat: base", files: { "v1.txt": "1\n", "v7.txt": "7\n", "pages/d.vue": "d\n" } }], home);
    const write = (file: string, text: string) => fs.writeFileSync(path.join(web, file), text);
    const staged = () => names(git(web, ["diff", "--cached", "--name-only", "-z"]));
    write("v1.txt", "1 wip\n");
    write("v7.txt", "7 wip\n");
    write("v[0-9].txt", "new\n");
    await gitWithPaths(runGit, web, ["v[0-9].txt"], ["add"]);
    assert.deepStrictEqual(staged(), ["v[0-9].txt"], "git add: only the checked file, not v1.txt and v7.txt its name matches as a pattern");
    await gitWithPaths(runGit, web, ["v[0-9].txt"], ["commit", "--only", "--file=-"], { input: "feat: v" });
    assert.deepStrictEqual(names(git(web, ["show", "--name-only", "-z", "--format=", "HEAD"])), ["v[0-9].txt"], "git commit --only: only the checked file");
    assert.deepStrictEqual(names(git(web, ["diff", "--name-only", "-z"])), ["v1.txt", "v7.txt"], "the others are left as they were");

    // A stopped merge's add -A, and Remove from VCS's reset: the same.
    write("pages/[id].vue", "id\n");
    write("pages/d.vue", "d wip\n");
    await gitWithPaths(runGit, web, ["pages/[id].vue"], ["add", "-A"]);
    assert.deepStrictEqual(staged(), ["pages/[id].vue"], "git add -A: not pages/d.vue");
    git(web, ["add", "pages/d.vue"]);
    await gitWithPaths(runGit, web, ["pages/[id].vue"], ["reset", "-q"]);
    assert.deepStrictEqual(staged(), ["pages/d.vue"], "git reset: only the file named");
    if (process.platform !== "win32") {
      // ":top" is git's short magic for "top": a file of that name, never the other one.
      write(":top", "colon\n");
      write("top", "plain\n");
      await gitWithPaths(runGit, web, [":top"], ["add"]);
      assert.deepStrictEqual(staged(), [":top", "pages/d.vue"]);
    }
    console.log("ok - real git: checked paths go to git add, add -A, commit --only and reset as files, never as patterns");

    // A repository inside this one: git lists its folder, none of its files.
    const inner = path.join(web, "acme-libs");
    fs.mkdirSync(inner);
    git(inner, ["init", "-q"]);
    fs.writeFileSync(path.join(inner, "lib.txt"), "l\n");
    const out = await runGit(web, statusArgs([]));
    assert.ok(out.split("\0").includes("? acme-libs/"), "git's own word for it");
    assert.ok(!splitStatus(out).changes.some((e) => e.path.startsWith("acme-libs")));
    console.log("ok - real git: an untracked nested repository is not listed as a file");

    // A submodule (a gitlink) with only its files changed: nothing of it for acme-web to commit.
    const api = path.join(home, "acme-api");
    makeRepo(api, [{ time: 1000, author: "dana", message: "feat: api", files: { "api.txt": "a\n" } }], home);
    const sub = path.join(home, "acme-app");
    makeRepo(sub, [{ time: 1000, author: "dana", message: "feat: app", files: { "app.txt": "a\n" } }], home);
    git(sub, ["clone", "-q", api, "acme-api"]);
    git(sub, ["add", "acme-api"]);
    git(sub, ["commit", "-qm", "feat: the api"]);
    fs.writeFileSync(path.join(sub, "acme-api", "api.txt"), "wip\n");
    fs.writeFileSync(path.join(sub, "acme-api", "new.txt"), "n\n");
    const changes = async () => splitStatus(await runGit(sub, statusArgs([]))).changes.map((e) => e.path);
    assert.deepStrictEqual(await changes(), [], "edited and new files inside it only");
    git(path.join(sub, "acme-api"), ["commit", "-qam", "feat: wip"]);
    assert.deepStrictEqual(await changes(), ["acme-api"], "checked out at a new commit: a change to commit");
    console.log("ok - real git: a submodule is a change only once its commit moved");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
