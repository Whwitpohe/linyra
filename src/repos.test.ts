import * as assert from "assert";
import {
  addExclusion, authorSuggestions, branchSuggestions, excludeRepos, globToRegExp, labelRepos, mergeRoots, undoExclusion } from "./repos";

{
  const repos = labelRepos(["/w/acme-web", "/w/acme-api", "/w/acme-web"]);
  assert.deepStrictEqual(repos, [
    { id: "/w/acme-api", root: "/w/acme-api", name: "acme-api" },
    { id: "/w/acme-web", root: "/w/acme-web", name: "acme-web" },
  ]);
  console.log("ok - labels are folder names, deduped and sorted; id is the root");
}
{
  const repos = labelRepos(["/a/team1/acme-web", "/a/team2/acme-web"]);
  assert.deepStrictEqual(repos.map((r) => r.name), ["acme-web (team1)", "acme-web (team2)"]);
  assert.notStrictEqual(repos[0].id, repos[1].id);
  const twice = labelRepos(["/x/team/acme-web", "/y/team/acme-web"]);
  assert.deepStrictEqual(twice.map((r) => r.name).sort(), ["/x/team/acme-web", "/y/team/acme-web"]);
  console.log("ok - same-named repos get distinct labels (parent folder, then full path)");
}
{
  assert.strictEqual(labelRepos(["C:\\src\\acme-api"])[0].name, "acme-api");
  console.log("ok - Windows paths label by folder name");
}
{
  assert.ok(globToRegExp("acme-*").test("acme-web"));
  assert.ok(!globToRegExp("*").test("a/b"), "* does not cross a slash");
  assert.ok(globToRegExp("**/vendor").test("vendor") && globToRegExp("**/vendor").test("/ws/x/vendor"));
  assert.ok(globToRegExp("**/vendor/**").test("/ws/vendor/lib"));
  assert.ok(!globToRegExp("acme.web").test("acmeXweb"), "regex characters are literal");
  assert.ok(globToRegExp("acme-?pi").test("acme-api"));
  console.log("ok - glob syntax: *, **, ?, literal punctuation");
}
{
  const repos = labelRepos(["/ws/acme-web", "/ws/acme-api", "/ws/vendor/acme-libs", "C:\\ws\\acme-docs"]);
  assert.deepStrictEqual(excludeRepos(repos, []).length, 4);
  assert.deepStrictEqual(excludeRepos(repos, ["acme-web"]).map((r) => r.root), ["/ws/acme-api", "C:\\ws\\acme-docs", "/ws/vendor/acme-libs"]);
  assert.deepStrictEqual(excludeRepos(repos, ["**/vendor/**"]).map((r) => r.root).includes("/ws/vendor/acme-libs"), false);
  assert.deepStrictEqual(excludeRepos(repos, ["C:/ws/*"]).map((r) => r.root).includes("C:\\ws\\acme-docs"), false);
  console.log("ok - excludeRepos matches folder name or full path (slashes normalized)");
}
{
  const folders = ["/w"];
  assert.deepStrictEqual(mergeRoots(["/w/acme-web", "/w/group/acme-api"], ["/w/acme-web"], folders), ["/w/acme-web", "/w/group/acme-api"],
    "a repo vscode.git did not open (deeper, or detection limited) is kept");
  assert.deepStrictEqual(mergeRoots(["/w/acme-web"], ["/w/acme-web", "/w/acme-web/vendor/acme-libs"], folders), ["/w/acme-web", "/w/acme-web/vendor/acme-libs"],
    "a repo vscode.git found (a submodule) is added");
  assert.deepStrictEqual(mergeRoots(["/w/acme-web"], ["/elsewhere/acme-api"], folders), ["/w/acme-web"], "repos outside the workspace folders stay out");
  assert.deepStrictEqual(mergeRoots([], ["/w"], ["/w"]), ["/w"], "a workspace folder that is itself a repo");
  console.log("ok - discovery merges the folder walk and vscode.git, so the list never shrinks");
}
{
  const lists = [["main", "origin/main", "origin/prod", "origin/HEAD", "bad name"], ["main", "origin/prod", "fix/ü"], ["main"]];
  assert.deepStrictEqual(branchSuggestions(lists), [{ name: "main", count: 3 }, { name: "origin/prod", count: 2 }, { name: "fix/ü", count: 1 }, { name: "origin/main", count: 1 }]);
  console.log("ok - branch suggestions are counted per repo, most shared first, and never offer a name the box refuses");
}

{
  const web = ["dana\x1fdana@example.com", "dana\x1fdana@example.com", "rin\x1frin@example.com"].join("\n");
  const api = ["Dana L\x1fDANA@example.com", "noor\x1fnoor@example.com", "", "garbage"].join("\n");
  assert.deepStrictEqual(authorSuggestions([web, api]), [
    { name: "dana", email: "dana@example.com", count: 3 },
    { name: "noor", email: "noor@example.com", count: 1 },
    { name: "rin", email: "rin@example.com", count: 1 },
  ], "one entry per email across repos (case-insensitive), most commits first, the most used name");
  assert.strictEqual(authorSuggestions([web], 1).length, 1, "capped");
  console.log("ok - author suggestions: one per email across repositories, most commits first");
}
{
  // Exclude from Linyra: the repo's exact path joins the list already in effect in that scope.
  assert.deepStrictEqual(addExclusion(undefined, "/ws/acme-libs"), ["/ws/acme-libs"], "no list yet");
  assert.deepStrictEqual(addExclusion(["**/vendor/**"], "/ws/acme-libs"), ["**/vendor/**", "/ws/acme-libs"], "the user's own entries stay");
  assert.strictEqual(addExclusion(["/ws/acme-libs"], "/ws/acme-libs"), null, "already there: nothing to write");
  // Undo: back to exactly what was there, down to "not set" (an empty list would still override other scopes).
  assert.strictEqual(undoExclusion(["/ws/acme-libs"], "/ws/acme-libs", undefined), undefined);
  assert.deepStrictEqual(undoExclusion(["**/vendor/**", "/ws/acme-libs"], "/ws/acme-libs", ["**/vendor/**"]), ["**/vendor/**"]);
  assert.deepStrictEqual(undoExclusion(["/ws/acme-libs"], "/ws/acme-libs", []), [], "an empty list the user had stays an empty list");
  assert.deepStrictEqual(undoExclusion(["/ws/acme-libs", "acme-scratch"], "/ws/acme-libs", undefined), ["acme-scratch"], "entries added since stay");
  console.log("ok - Exclude adds the exact path to the list in effect; Undo restores it exactly");
}
