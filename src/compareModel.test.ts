import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  bothPaths, candidates, COMMIT_PAGE, conflictNames, conflictNote, isConflict, sameNow, shownFiles, tipPaths, tipsDiffArgs, filesArgs, logArgs, mergeBaseArgs, mergeMessage, mergeTreeArgs, mergeTreeFailure,
  mergeSkips, mirror, pairDuplicates, parseFiles, parseMergeTree, parseResolve, parseSideCount, parseSideLog, pickerGroups, previewPaths, pushRecent, refsOf, releaseNotes, repoCounts, resolveInput, sideLabel, sideOf,
  sidePage, repoDescription, sideCountArgs, summaryLabel, tabTitle, validPair, type RepoCompare,
} from "./compareModel";
import { commitAt, gitEnv, makeRepo } from "./fixtures";
import { multiCommands } from "./multiRepoModel";
import type { FileChange } from "./types";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

// Branch names from the webview: only refs git would accept as a branch name.
assert.ok(validPair({ left: "origin/release-1.4", right: "main" }));
for (const bad of ["-x", "a..b", "HEAD~3", "", "x  y", " x", "x y x", "re^{commit}", "a b c d e f"]) assert.ok(!validPair({ left: bad, right: "main" }), bad);
assert.ok(!validPair({ left: "main" }));
assert.ok(!validPair(null));
// A side may list several names, in order: a repository uses the first it has.
assert.ok(validPair({ left: "develop develop-k", right: "master main origin/HEAD" }));
assert.deepStrictEqual(candidates("develop develop-k"), ["develop", "develop-k"]);
assert.strictEqual(sideOf(["develop", "develop-k", "develop"]), "develop develop-k");
assert.strictEqual(sideLabel("develop develop-k"), "develop, develop-k");
console.log("ok - a pair is names git accepts as branches; a side may list several, in order");

const T1 = "1".repeat(40);
const T2 = "2".repeat(40);
const p0 = { left: "develop develop-k", right: "master main" };
// Each name as a branch, a remote branch, then a tag: never git's loose lookup.
const asRefs = (name: string) => [`refs/heads/${name}`, `refs/remotes/${name}`, `refs/tags/${name}`];
assert.deepStrictEqual(refsOf("origin/main"), ["refs/heads/origin/main", "refs/remotes/origin/main", "refs/tags/origin/main"]);
assert.deepStrictEqual(refsOf("refs/tags/v1.4.0"), ["refs/tags/v1.4.0"], "a full ref as given");
assert.strictEqual(resolveInput({ left: "develop", right: "main" }), [...asRefs("develop"), ...asRefs("main")].flatMap((r) => [`${r}^{commit}`, `${r}^{tree}`]).join("\n") + "\n");
// cat-file --batch-check answers two lines per ref: the first name each side has wins, as its first ref.
const answer = (lines: string[]) => lines.join("\n") + "\n";
const none = (name: string) => asRefs(name).flatMap((r) => [`${r}^{commit} missing`, `${r}^{tree} missing`]);
const has = (name: string, at: number, sha: string, tree: string) => asRefs(name).flatMap((r, i) => (i === at ? [`${sha} commit 200`, `${tree} tree 90`] : [`${r}^{commit} missing`, `${r}^{tree} missing`]));
assert.deepStrictEqual(parseResolve(p0, answer([...none("develop"), ...has("develop-k", 1, A, T1), ...none("master"), ...has("main", 0, B, T2)])),
  { left: { name: "develop-k", sha: A, tree: T1 }, right: { name: "main", sha: B, tree: T2 } });
assert.deepStrictEqual(parseResolve(p0, answer([...has("develop", 0, A, T1), ...has("develop-k", 0, C, T2), ...has("master", 2, B, T1), ...none("main")])),
  { left: { name: "develop", sha: A, tree: T1 }, right: { name: "master", sha: B, tree: T1 } }, "the first one wins even when a later one exists too");
assert.deepStrictEqual(parseResolve({ left: "main", right: "x" }, answer([`${A} commit 1`, `${T1} tree 1`, `${B} commit 1`, `${T2} tree 1`, ...none("x")])).left, { name: "main", sha: A, tree: T1 }, "the branch before the remote branch");
assert.deepStrictEqual(parseResolve(p0, answer([...none("develop"), ...none("develop-k"), ...has("master", 0, B, T1), ...none("main")])).left, undefined, "none of a side's names: missing");
console.log("ok - each repository uses the first name of each side it has, all resolved in one git process");

{
  // Real git: a tag named like the branch, and a branch named like a commit's hash. The branch
  // wins over the tag; a name no ref has is missing, though git would read it as that commit.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-compare-"));
  const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: repo, input, env: gitEnv(home), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const repo = path.join(home, "acme-api");
  try {
    makeRepo(repo, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "1\n" } }], home);
    const base = git(["rev-parse", "HEAD"]).trim();
    git(["tag", "release-1.4"]);
    git(["branch", "release-1.4"]);
    commitAt(repo, home, { time: 1100, author: "rin", message: "fix: on main", files: { "a.txt": "2\n" } });
    git(["update-ref", "refs/heads/release-1.4", "HEAD"]);
    const prefix = base.slice(0, 7);
    const p = { left: `${prefix} release-1.4`, right: "main" };
    const r = parseResolve(p, git(["cat-file", "--batch-check"], resolveInput(p)));
    assert.deepStrictEqual([r.left?.name, r.left?.sha], ["release-1.4", git(["rev-parse", "refs/heads/release-1.4"]).trim()], "the branch, not the tag; not the commit the hash names");
    const t = { left: "release-1.4", right: "refs/tags/release-1.4" };
    assert.strictEqual(parseResolve(t, git(["cat-file", "--batch-check"], resolveInput(t))).right?.sha, base, "the tag, named in full");
    console.log("ok - real git: a branch before a tag of its name, and no name read as a commit's hash");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

assert.deepStrictEqual(mergeBaseArgs(A, B), ["merge-base", A, B]);
assert.deepStrictEqual(mergeTreeArgs(A, B), ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", A, B]);
assert.deepStrictEqual(parseMergeTree(`${T1}\0`), { tree: T1, conflicts: [] }, "merges cleanly");
assert.deepStrictEqual(parseMergeTree(`${T1}\0src/a.ts\0src/b.ts\0src/a.ts\0`), { tree: T1, conflicts: ["src/a.ts", "src/b.ts"] }, "each conflicted file once");
assert.deepStrictEqual(parseMergeTree(`${"e".repeat(64)}\0`), { tree: "e".repeat(64), conflicts: [] }, "a SHA-256 repository");
// git exits 1 on an error too, with nothing on stdout: no answer, not "merges cleanly".
assert.strictEqual(parseMergeTree(""), undefined);
assert.strictEqual(parseMergeTree("merge-tree: feature - not something we can merge\n"), undefined);
assert.strictEqual(mergeTreeFailure("refusing to merge unrelated histories"), "nobase");
assert.strictEqual(mergeTreeFailure("unknown option `write-tree'"), "unsupported", "git before 2.38");
assert.strictEqual(mergeTreeFailure("bad object"), "error");
assert.ok(isConflict(["src/a.ts"], { path: "src/a.ts" }) && isConflict(["old.ts"], { path: "new.ts", oldPath: "old.ts" }) && !isConflict(null, { path: "src/a.ts" }));
console.log("ok - the merge check: merge-tree in memory, its conflicted files, and why it could not tell");

{
  // ◀ renamed old.txt to new.txt and edited it; ▶ edited old.txt. merge-tree names the conflict new.txt.
  const renamed: FileChange = { path: "new.txt", oldPath: "old.txt", status: "R", added: 1, deleted: 1 };
  const edited: FileChange = { path: "old.txt", status: "M", added: 1, deleted: 1 };
  const names = conflictNames(["new.txt"], [renamed]);
  assert.ok(isConflict(names, renamed) && isConflict(names, edited), "both sides' rows are the conflict");
  assert.strictEqual(conflictNames(null, [renamed]), null);
  assert.deepStrictEqual(conflictNames(["other.txt"], [renamed]), ["other.txt"], "a rename adds its old name only when its new one conflicts");
  const files = { left: [renamed], right: [edited] };
  assert.deepStrictEqual(previewPaths("left", renamed, ["new.txt"], files), { merged: "new.txt", right: "old.txt" });
  assert.deepStrictEqual(previewPaths("right", edited, ["new.txt"], files), { merged: "new.txt", right: "old.txt" });
  // The other way: ▶ renamed it, ◀ edited the old name. ▶ has it as new.txt now.
  const swapped = { left: [edited], right: [renamed] };
  assert.deepStrictEqual(previewPaths("left", edited, ["new.txt"], swapped), { merged: "new.txt", right: "new.txt" });
  assert.deepStrictEqual(previewPaths("right", renamed, ["new.txt"], swapped), { merged: "new.txt", right: "new.txt" });
  assert.deepStrictEqual(previewPaths("left", { path: "a.ts" }, ["a.ts"], { left: [], right: [] }), { merged: "a.ts", right: "a.ts" }, "no rename");
  console.log("ok - a conflict on a file one side renamed: both sides' rows, and the merged file under the name the merge keeps");
}

{
  // Real git: the rename on ◀, the edit on ▶, and what merge-tree and Files mode name.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-compare-"));
  const repo = path.join(home, "acme-web");
  const git = (args: string[]) => {
    try { return execFileSync("git", args, { cwd: repo, env: gitEnv(home), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { if ((e as { status?: number }).status === 1) return String((e as { stdout?: unknown }).stdout); throw e; }
  };
  try {
    const lines = Array.from({ length: 20 }, (_, i) => `${i + 1}`);
    const text = (at: number, s: string) => lines.map((l, i) => (i === at ? s : l)).join("\n") + "\n";
    makeRepo(repo, [{ time: 1000, author: "dana", message: "feat: base", files: { "old.txt": text(-1, "") } }], home);
    git(["switch", "-q", "-c", "release-1.4"]);
    commitAt(repo, home, { time: 1100, author: "dana", message: "refactor: rename", files: { "old.txt": null, "new.txt": text(9, "release") } });
    git(["switch", "-q", "main"]);
    commitAt(repo, home, { time: 1200, author: "rin", message: "fix: on main", files: { "old.txt": text(9, "main") } });
    const merged = parseMergeTree(git(mergeTreeArgs("release-1.4", "main")))!;
    assert.deepStrictEqual(merged.conflicts, ["new.txt"]);
    const files = { left: parseFiles(git(filesArgs("main", "release-1.4"))), right: parseFiles(git(filesArgs("release-1.4", "main"))) };
    const names = conflictNames(merged.conflicts, [...files.left, ...files.right]);
    assert.deepStrictEqual([files.left.map((f) => isConflict(names, f)), files.right.map((f) => isConflict(names, f))], [[true], [true]], "the rename and the edit");
    for (const side of ["left", "right"] as const) {
      const at = previewPaths(side, files[side][0], merged.conflicts, files);
      assert.match(git(["cat-file", "blob", `${merged.tree}:${at.merged}`]), /^<<<<<<< /m, `${side}: the merged file, its markers`);
      assert.strictEqual(git(["cat-file", "blob", `main:${at.right}`]), text(9, "main"), `${side}: ▶ as it is now`);
    }
    console.log("ok - real git: a conflict on a file ◀ renamed is found on both sides, and its merge previews");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

{
  // Real git: ▶ checked out; ◀ moved on after the comparison (a fetch, a commit). The merge takes ◀
  // as compared, named as its branch, not the new commit nobody checked.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-compare-"));
  const repo = path.join(home, "acme-web");
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...gitEnv(home), GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    makeRepo(repo, [{ time: 1000, author: "dana", message: "feat: base", files: { "a.txt": "1\n" } }], home);
    git(["switch", "-q", "-c", "release-1.4"]);
    commitAt(repo, home, { time: 1100, author: "dana", message: "feat: billing page", files: { "billing.ts": "export {};\n" } });
    const compared = git(["rev-parse", "HEAD"]);
    commitAt(repo, home, { time: 1200, author: "rin", message: "feat: not reviewed", files: { "late.ts": "export {};\n" } });
    git(["switch", "-q", "main"]);
    commitAt(repo, home, { time: 1300, author: "dana", message: "fix: on main", files: { "a.txt": "2\n" } });
    git(multiCommands.merge(compared, mergeMessage("release-1.4", "main")));
    assert.deepStrictEqual(git(["rev-list", "--parents", "-1", "HEAD"]).split(" ").slice(2), [compared], "◀ as compared");
    assert.strictEqual(git(["log", "-1", "--format=%s"]), "Merge branch 'release-1.4' into main");
    assert.ok(!fs.existsSync(path.join(repo, "late.ts")), "◀'s later commit is not merged");
    console.log("ok - real git: Merge ◀ into ▶ where ▶ is checked out merges ◀ as compared, named as its branch");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
assert.deepStrictEqual(sideCountArgs("left", A, B), ["rev-list", "--left-only", "--cherry-mark", "--no-merges", "--count", `${A}...${B}`]);
assert.deepStrictEqual(sideCountArgs("right", A, B), ["rev-list", "--right-only", "--cherry-mark", "--no-merges", "--count", `${A}...${B}`]);
assert.deepStrictEqual(parseSideCount("2\t1\n"), { only: 2, same: 1 });
assert.deepStrictEqual(parseSideCount("3\n"), { only: 3, same: 0 });
assert.deepStrictEqual(parseSideCount(""), { only: 0, same: 0 });
console.log("ok - each side counts its own commits and its duplicates");

assert.deepStrictEqual(filesArgs(C, A), ["diff", "--raw", "--numstat", "-z", "-M", `${C}...${A}`], "since the split, without reading the split point first");
// --raw records, then --numstat records; a rename carries both names.
const raw = [
  ":000000 100644 0000000 1111111 A", "src/limit.go",
  ":100644 100644 2222222 3333333 R090", "src/old.go", "src/new.go",
  ":100644 100644 4444444 5555555 M", "bin.png",
  "40\t0\tsrc/limit.go", "1\t1\t", "src/old.go", "src/new.go", "-\t-\tbin.png", "",
].join("\0");
const files = parseFiles(raw);
assert.deepStrictEqual(files.map((f) => [f.path, f.oldPath, f.status, f.added, f.deleted]), [
  ["src/limit.go", undefined, "A", 40, 0],
  ["src/new.go", "src/old.go", "R", 1, 1],
  ["bin.png", undefined, "M", null, null],
]);
console.log("ok - Files reads each changed file with its status, rename and counts");

const other = parseFiles(["1\t1\tsrc/new.go", "2\t0\tREADME.md", ""].join("\0"));
assert.deepStrictEqual([...bothPaths(files, other)], ["src/new.go"]);
console.log("ok - a file changed on both sides is matched on its new path");

assert.deepStrictEqual(tipsDiffArgs(A, B), ["diff", "--name-only", "-z", "--no-renames", A, B]);
// A cherry-pick on both sides leaves the file the same at both tips; a later change on one does not.
assert.deepStrictEqual([...sameNow(new Set(["retry.go", "limit.go", "a b/c.go"]), ["limit.go", "other.go", ""].join("\0"))].sort(), ["a b/c.go", "retry.go"]);
assert.deepStrictEqual([...sameNow(new Set(["x.go"]), "")], ["x.go"]);
console.log("ok - a file changed on both sides but not between the tips is the same now");

{
  const fs3 = parseFiles(["1\t0\ta.go", "2\t0\tb.go", "3\t0\tc.go", ""].join("\0"));
  const same = new Set(["b.go"]);
  assert.deepStrictEqual(shownFiles(fs3, same, true).shown.map((f) => f.path), ["a.go", "c.go"]);
  assert.strictEqual(shownFiles(fs3, same, true).hidden, 1);
  assert.deepStrictEqual(shownFiles(fs3, same, false).shown.map((f) => f.path), ["a.go", "b.go", "c.go"]);
  assert.strictEqual(shownFiles(fs3, same, false).hidden, 0);
  console.log("ok - Hide Files Already on Both leaves them out and counts them");
}

// A rename on one side: the other tip still has the file under its old name.
assert.deepStrictEqual(tipPaths("left", { path: "rate.go", oldPath: "limit.go" }), { left: "rate.go", right: "limit.go" });
assert.deepStrictEqual(tipPaths("right", { path: "rate.go", oldPath: "limit.go" }), { left: "limit.go", right: "rate.go" });
assert.deepStrictEqual(tipPaths("left", { path: "a.go" }), { left: "a.go", right: "a.go" });
console.log("ok - a file renamed on one side opens against its old name at the other tip");

assert.deepStrictEqual(logArgs("left", A, B, COMMIT_PAGE), [
  "log", "--left-only", "--cherry-mark", "--no-merges", "--max-count=500", "--format=%m%x1f%H%x1f%P%x1f%ct%x1f%aN%x1f%s%x1e", `${A}...${B}`,
]);
const log = parseSideLog(`<\x1f${A}\x1f${C}\x1f1758000300\x1fdana\x1ffeat: rate limit\x1e\n=\x1f${B}\x1f${C} ${A}\x1f1758000200\x1frin\x1ffix: retry on 503\x1e\n`);
assert.deepStrictEqual(log, [
  { mark: "+", sha: A, parents: [C], time: 1758000300, author: "dana", subject: "feat: rate limit" },
  { mark: "=", sha: B, parents: [C, A], time: 1758000200, author: "rin", subject: "fix: retry on 503" },
]);
console.log("ok - a side's log marks its duplicates");

const dl = [{ mark: "=" as const, sha: A, parents: [], time: 2, author: "dana", subject: "fix: retry on 503" }, { mark: "=" as const, sha: C, parents: [], time: 1, author: "dana", subject: "fix: squash" }];
const dr = [{ mark: "=" as const, sha: B, parents: [], time: 3, author: "rin", subject: "fix: retry on 503" }];
assert.deepStrictEqual(pairDuplicates(dl, dr), [
  { subject: "fix: retry on 503", left: A, right: B },
  { subject: "fix: squash", left: C },
]);
console.log("ok - duplicates pair up by subject, the rest stay on their side");

const differs: RepoCompare = { kind: "differs", leftName: "develop", rightName: "main", leftSha: A, rightSha: B, base: C, left: 2, right: 1, sameLeft: 1, sameRight: 1, conflicts: ["a.ts"] };
assert.deepStrictEqual(mirror(differs), { kind: "differs", leftName: "main", rightName: "develop", leftSha: B, rightSha: A, base: C, left: 1, right: 2, sameLeft: 1, sameRight: 1, conflicts: ["a.ts"] }, "conflicts are the same either way round");
assert.deepStrictEqual(mirror({ kind: "missing" }), { kind: "missing" });
console.log("ok - swap mirrors a result without reading git");

const results: RepoCompare[] = [differs, { ...differs, left: 5, right: 0, sameLeft: 0, sameRight: 0, conflicts: [] }, { kind: "identical" }, { kind: "missing" }, { kind: "missing" }, { kind: "nobase" }];
assert.strictEqual(summaryLabel(results, 6), "3 repositories differ · 1 with conflicts · 1 identical · 2 missing a branch · in 6 repositories", "no commit numbers");
assert.deepStrictEqual([conflictNote(differs), conflictNote(results[1]), conflictNote({ ...differs, conflicts: null }), conflictNote({ kind: "nobase" })], ["1 conflicted file", "merges cleanly", "", ""]);
assert.strictEqual(summaryLabel([{ kind: "identical" }], 1), "0 repositories differ · 1 identical · in 1 repository");
assert.strictEqual(summaryLabel([{ ...results[1] }], 1), "1 repository differs · in 1 repository", "no =0, no 0 identical");
console.log("ok - the summary counts what differs, what is identical and what is missing");

assert.strictEqual(tabTitle({ left: "origin/release-1.4", right: "origin/main" }), "release-1.4 ↔ main");
assert.strictEqual(tabTitle(null), "");
assert.strictEqual(tabTitle({ left: "main", right: "" }), "");
assert.strictEqual(tabTitle({ left: "origin/develop develop-k", right: "master main" }), "develop, develop-k ↔ master, main");
console.log("ok - the view's description is the pair");

const p1 = { left: "origin/release-1.4", right: "origin/main" };
const p2 = { left: "origin/release-1.3", right: "origin/prod" };
let recent = pushRecent([], p1);
recent = pushRecent(recent, p2);
recent = pushRecent(recent, p1);
assert.deepStrictEqual(recent, [p1, p2]);
for (let i = 0; i < 9; i++) recent = pushRecent(recent, { left: `rel-${i}`, right: "main" });
assert.strictEqual(recent.length, 5);
console.log("ok - recent pairs: newest first, once each, at most five");

const names = [{ name: "origin/main", count: 68 }, { name: "main", count: 68 }, { name: "origin/release-1.4", count: 56 }, { name: "feat/billing", count: 3 }];
const groups = pickerGroups(names, ["origin/main"], [p1], "");
assert.deepStrictEqual(groups.map((g) => [g.title, g.items.length]), [["Recent pairs", 1], ["Favorites", 1], ["Local", 2], ["Remote", 2]]);
// Each repository's default branch, and each name's place among this side's ticked ones (0: not ticked).
const withSide = pickerGroups(names, [], [], "", ["origin/main", "main"], [{ name: "origin/HEAD", count: 60 }]);
assert.deepStrictEqual(withSide.map((g) => g.title), ["Default branch", "Local", "Remote"]);
assert.deepStrictEqual(withSide.flatMap((g) => g.items.map((i) => i.kind === "name" && [i.name, i.order])), [["origin/HEAD", 0], ["main", 2], ["feat/billing", 0], ["origin/main", 1], ["origin/release-1.4", 0]]);
// A ticked name no repository has is still listed, to untick.
assert.deepStrictEqual(pickerGroups(names, [], [], "", ["develop-k", "main"]).map((g) => [g.title, g.items.length]), [["Not in any ticked repository", 1], ["Local", 2], ["Remote", 2]]);
const searched = pickerGroups(names, ["origin/main"], [p1], "REL");
assert.deepStrictEqual(searched.map((g) => g.title), ["Remote"]);
assert.deepStrictEqual(pickerGroups(names, [], [], "zzz"), []);
console.log("ok - the Branch picker groups names and filters them as you type");

// A repository row says only = (when there is one), or why it cannot be compared.
const row = { kind: "differs" as const, leftName: "develop", rightName: "main", leftSha: A, rightSha: B, base: C, left: 3, right: 1, sameLeft: 2, sameRight: 2, conflicts: null };
assert.strictEqual(repoDescription(row), "=2");
assert.strictEqual(repoDescription({ ...row, sameLeft: 0, sameRight: 0 }), "");
assert.strictEqual(repoDescription({ kind: "nobase" }), "no common history");
assert.strictEqual(repoDescription({ kind: "error", reason: "bad object" }), "git error");
console.log("ok - a repository row shows = only when there is one, or why it cannot be compared");

// A Repositories row: where the work is, without expanding (merges are not counted).
const rc = { kind: "differs" as const, leftName: "develop", rightName: "main", leftSha: A, rightSha: B, base: C, left: 3, right: 1, sameLeft: 1, sameRight: 1, conflicts: null };
assert.strictEqual(repoCounts(rc), "3 ◀ · 1 ▶ · =1");
assert.strictEqual(repoCounts({ ...rc, right: 0, sameLeft: 0, sameRight: 0 }), "3 ◀");
assert.strictEqual(repoCounts({ ...rc, left: 0, sameLeft: 0, sameRight: 0, right: 2 }), "2 ▶");
assert.strictEqual(repoCounts({ ...rc, left: 0, right: 0, sameLeft: 3, sameRight: 3 }), "=3");
assert.strictEqual(repoCounts({ kind: "nobase" }), "no common history");
console.log("ok - a Repositories row counts each side's commits and the duplicates, zeros left out");

// A side's page of commits: "Show more" whenever git returned more than the page, duplicates included.
const sc = (sha: string, mark: "+" | "=") => ({ mark, sha, parents: [], time: 0, author: "dana", subject: sha });
assert.deepStrictEqual(sidePage([sc("a", "+"), sc("b", "="), sc("c", "+")], 2), { rows: [sc("a", "+")], more: true }, "a duplicate in the page still leaves more to show");
assert.deepStrictEqual(sidePage([sc("a", "+"), sc("c", "+")], 2), { rows: [sc("a", "+"), sc("c", "+")], more: false });
console.log("ok - a side's commit page offers more whenever git returned more than the page");

// Copy as Release Notes: each repository's own commits, a repository with none left out.
assert.strictEqual(releaseNotes([
  { repo: "acme-api", from: "develop-k", into: "main", commits: [{ ...sc(A, "+"), subject: "fix: retry on 503" }, { ...sc(B, "+"), subject: "feat: rate limit", author: "rin" }] },
  { repo: "acme-web", from: "develop", into: "main", commits: [] },
]), "## acme-api (develop-k → main)\n\n- fix: retry on 503 (aaaaaaa, dana)\n- feat: rate limit (bbbbbbb, rin)\n");
console.log("ok - release notes: Markdown, one section per repository with commits");

// Merge ◀ into ▶ leaves repositories out once per reason, never once per repository.
const skips = mergeSkips([
  { name: "acme-web", why: "worktree", into: "main" }, { name: "acme-api", why: "conflict", files: 2 },
  { name: "acme-libs", why: "worktree", into: "main" }, { name: "acme-docs", why: "remote", into: "origin/main" },
]);
assert.strictEqual(skips.summary, "2 repositories: main is checked out in another worktree · 1 repository: a merge would conflict · 1 repository: origin/main is not a local branch");
assert.strictEqual(skips.detail, "2 repositories: main is checked out in another worktree\nacme-web, acme-libs\n\n1 repository: a merge would conflict\nacme-api (2 files)\n\n1 repository: origin/main is not a local branch\nacme-docs");
assert.strictEqual(mergeSkips([{ name: "acme-web", why: "behind", into: "main" }]).summary, "1 repository: main is behind its upstream (Update Project first)", "Release…");
assert.strictEqual(mergeSkips([{ name: "acme-web", why: "unchecked" }, { name: "acme-api", why: "unchecked" }]).detail, "2 repositories: not checked for conflicts yet (Refresh)\nacme-web, acme-api", "no clean merge known: not offered");
console.log("ok - Merge leaves repositories out grouped by why");
