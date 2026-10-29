import * as assert from "assert";
import {
  bothPaths, candidates, COMMIT_PAGE, conflictNote, isConflict, sameNow, shownFiles, tipPaths, tipsDiffArgs, filesArgs, logArgs, mergeBaseArgs, mergeTreeArgs, mergeTreeFailure,
  mergeSkips, mirror, pairDuplicates, parseFiles, parseMergeTree, parseResolve, parseSideCount, parseSideLog, pickerGroups, pushRecent, releaseNotes, repoCounts, resolveInput, sideLabel, sideOf,
  sidePage, repoDescription, sideCountArgs, summaryLabel, tabTitle, validPair, type RepoCompare,
} from "./compareModel";

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
assert.strictEqual(resolveInput(p0), "develop^{commit}\ndevelop^{tree}\ndevelop-k^{commit}\ndevelop-k^{tree}\nmaster^{commit}\nmaster^{tree}\nmain^{commit}\nmain^{tree}\n");
// cat-file --batch-check answers one line per name: the first each side has wins.
const answer = (lines: string[]) => lines.join("\n") + "\n";
assert.deepStrictEqual(parseResolve(p0, answer(["develop^{commit} missing", "develop^{tree} missing", `${A} commit 200`, `${T1} tree 90`, "master^{commit} missing", "master^{tree} missing", `${B} commit 210`, `${T2} tree 95`])),
  { left: { name: "develop-k", sha: A, tree: T1 }, right: { name: "main", sha: B, tree: T2 } });
assert.deepStrictEqual(parseResolve(p0, answer([`${A} commit 200`, `${T1} tree 90`, `${C} commit 1`, `${T2} tree 1`, `${B} commit 210`, `${T1} tree 90`, "main^{commit} missing", "main^{tree} missing"])),
  { left: { name: "develop", sha: A, tree: T1 }, right: { name: "master", sha: B, tree: T1 } }, "the first one wins even when a later one exists too");
assert.deepStrictEqual(parseResolve(p0, answer(["develop^{commit} missing", "develop^{tree} missing", "develop-k^{commit} ambiguous", "develop-k^{tree} ambiguous", `${B} commit 1`, `${T1} tree 1`, "", ""])).left, undefined, "none of a side's names: missing");
console.log("ok - each repository uses the first name of each side it has, all resolved in one git process");

assert.deepStrictEqual(mergeBaseArgs(A, B), ["merge-base", A, B]);
assert.deepStrictEqual(mergeTreeArgs(A, B), ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", A, B]);
assert.deepStrictEqual(parseMergeTree(`${T1}\0`), { tree: T1, conflicts: [] }, "merges cleanly");
assert.deepStrictEqual(parseMergeTree(`${T1}\0src/a.ts\0src/b.ts\0src/a.ts\0`), { tree: T1, conflicts: ["src/a.ts", "src/b.ts"] }, "each conflicted file once");
assert.strictEqual(mergeTreeFailure("refusing to merge unrelated histories"), "nobase");
assert.strictEqual(mergeTreeFailure("unknown option `write-tree'"), "unsupported", "git before 2.38");
assert.strictEqual(mergeTreeFailure("bad object"), "error");
assert.ok(isConflict(["src/a.ts"], { path: "src/a.ts" }) && isConflict(["old.ts"], { path: "new.ts", oldPath: "old.ts" }) && !isConflict(null, { path: "src/a.ts" }));
console.log("ok - the merge check: merge-tree in memory, its conflicted files, and why it could not tell");
assert.deepStrictEqual(sideCountArgs("left", A, B), ["rev-list", "--left-only", "--cherry-mark", "--no-merges", "--count", `${A}...${B}`]);
assert.deepStrictEqual(sideCountArgs("right", A, B), ["rev-list", "--right-only", "--cherry-mark", "--no-merges", "--count", `${A}...${B}`]);
assert.deepStrictEqual(parseSideCount("2\t1\n"), { only: 2, same: 1 });
assert.deepStrictEqual(parseSideCount("3\n"), { only: 3, same: 0 });
assert.deepStrictEqual(parseSideCount(""), { only: 0, same: 0 });
console.log("ok - each side counts its own commits and its duplicates");

assert.deepStrictEqual(filesArgs(C, A), ["diff", "--raw", "--numstat", "-z", "-M", C, A]);
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
console.log("ok - Merge leaves repositories out grouped by why");
