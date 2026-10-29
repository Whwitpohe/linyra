import * as assert from "assert";
import { branchGroupKey, DEFAULT_BRANCH_SIDEBAR, parseBranches } from "../branchModel";
import { collapseAll, expandAll, parentIndex, repoTreeKey, treeRows, wantedBranchData, withOperations } from "./repoTreeModel";

const sha = "a".repeat(40);
const line = (...f: string[]) => f.join("\0");
const repos = ["acme-web", "acme-api", "acme-libs"].map((name) => ({ id: `/w/${name}`, root: `/w/${name}`, name }));
const web = parseBranches([
  line("refs/heads/main", sha, "*", "", "", "", ""), line("refs/heads/release-1.4", sha, " ", "", "", "", ""),
  line("refs/remotes/origin/main", sha, " ", "", "", "", ""), line("refs/tags/v1.4.0", sha, " ", "", "", "", ""),
].join("\n"), ["origin"]);
const data = new Map([[repos[0].id, { data: web }], [repos[1].id, { loading: true }]]);
const labels = (rows: ReturnType<typeof treeRows>) => rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "repo" ? r.name : r.kind === "all" ? "All" : "label" in r ? r.label : r.kind}`);

{
  const closed = treeRows(repos, "", [], null, data, DEFAULT_BRANCH_SIDEBAR);
  assert.deepStrictEqual(labels(closed), ["All", "acme-web", "acme-api", "acme-libs"], "closed: the repository list as before");
  const state = { ...DEFAULT_BRANCH_SIDEBAR, expanded: [repoTreeKey(repos[0].id), branchGroupKey("local", repos[0].id), repoTreeKey(repos[1].id)] };
  const open = treeRows(repos, "", [], null, data, state);
  assert.deepStrictEqual(labels(open), ["All", "acme-web", "  Local", "    main", "    release-1.4", "  Remote", "  Tags", "acme-api", "  Reading branches…", "acme-libs"]);
  assert.deepStrictEqual(wantedBranchData(repos, state, "").map((r) => r.name), ["acme-web", "acme-api"], "only opened repositories read their branches");
  assert.strictEqual(parentIndex(open, 3), 2, "a branch's parent is its group");
  assert.strictEqual(parentIndex(open, 2), 1, "a group's parent is its repository");
  console.log("ok - each repository opens onto Local, Remote and Tags; unopened ones read nothing");
}

{
  const found = treeRows(repos, "release", [], null, data, DEFAULT_BRANCH_SIDEBAR);
  assert.deepStrictEqual(labels(found), ["All", "acme-web", "  Local", "    release-1.4"], "a branch name finds its repository, opened on the match");
  const byRepo = treeRows(repos, "web", [], null, data, DEFAULT_BRANCH_SIDEBAR);
  assert.deepStrictEqual(labels(byRepo), ["All", "acme-web"], "found by its own name: listed, not opened");
  const opened = treeRows(repos, "web", [], null, data, { ...DEFAULT_BRANCH_SIDEBAR, expanded: [repoTreeKey(repos[0].id)] });
  assert.ok(labels(opened).includes("    v1.4.0") && labels(opened).includes("      main"), "opened and found by name: every branch, remotes nested");
  assert.deepStrictEqual(wantedBranchData(repos, DEFAULT_BRANCH_SIDEBAR, "x").length, 3, "searching reads every repository's branches");
  console.log("ok - the pane's search matches repository names and branch names together");
}

{
  const remote = `${branchGroupKey("remote", repos[0].id)}\0origin`;
  const before = { ...DEFAULT_BRANCH_SIDEBAR, expanded: [branchGroupKey("remote", repos[0].id), remote], favorites: ["fav"] };
  const all = expandAll(repos, before);
  assert.deepStrictEqual(wantedBranchData(repos, all, "").map((r) => r.name), ["acme-web", "acme-api", "acme-libs"], "every repository opens (and reads its branches)");
  const rows = treeRows(repos, "", [], null, data, all);
  assert.ok(rows.some((r) => r.kind === "branch" && r.label === "release-1.4"), "on its Local branches");
  assert.ok(all.expanded.includes(remote), "a remote the user opened stays open");
  assert.ok(!all.expanded.includes(branchGroupKey("tag", repos[0].id)), "Tags are not opened for the user");
  assert.deepStrictEqual(expandAll(repos, all).expanded.length, all.expanded.length, "twice is the same");
  const none = collapseAll(all);
  assert.deepStrictEqual(none.expanded, []);
  assert.deepStrictEqual(none.favorites, ["fav"], "favorites stay");
  assert.deepStrictEqual(labels(treeRows(repos, "", [], null, data, none)), ["All", "acme-web", "acme-api", "acme-libs"]);
  console.log("ok - Expand All opens every repository on its Local branches; Collapse All closes everything, keeping favorites");
}

{
  // A stopped merge: a row right under its repository, before its groups; the keyboard's parent is the repository.
  const state = { ...DEFAULT_BRANCH_SIDEBAR, expanded: [repoTreeKey(repos[0].id), branchGroupKey("local", repos[0].id)] };
  const rows = withOperations(treeRows(repos, "", [], null, data, state), new Map([[repos[0].id, { operation: "merge" as const, conflicts: 2 }], [repos[2].id, { operation: "rebase" as const, conflicts: 0 }]]));
  const kinds = rows.map((r) => (r.kind === "operation" ? `op:${r.operation}:${r.conflicts}` : r.kind === "repo" ? r.name : "label" in r ? r.label : r.kind));
  assert.deepStrictEqual(kinds, ["all", "acme-web", "op:merge:2", "Local", "main", "release-1.4", "Remote", "Tags", "acme-api", "acme-libs", "op:rebase:0"]);
  assert.strictEqual(parentIndex(rows, 2), 1, "its parent is its repository");
  assert.deepStrictEqual(rows.flatMap((r) => (r.kind === "operation" ? [r.child] : [])), [true, false], "a collapsed repository's row is not its child (a collapsed item shows none)");
  assert.strictEqual(new Set(rows.map((r) => r.key)).size, rows.length, "keys stay unique");
  assert.deepStrictEqual(withOperations(rows.filter((r) => r.kind !== "operation"), new Map()).length, rows.length - 2, "nothing stopped: no row");
  console.log("ok - a stopped operation is a row right under its repository");
}
