import * as assert from "assert";
import { DEFAULT_BRANCH_SIDEBAR } from "../branchModel";
import { clampPaneWidth, DEFAULT_REPO_PANE_WIDTH, PaneWidth, fuzzyMatch, isChecked, keptCursor, pickOnly, toggleRepo, visibleRepos, paneRows, type PaneRow } from "./repoPaneModel";
import { repoTreeKey, treeRows, withOperations } from "./repoTreeModel";

const all = ["/ws/acme-api", "/ws/acme-libs", "/ws/acme-web"];
const repos = all.map((id) => ({ id, name: id.slice(4) }));

{
  assert.deepStrictEqual(pickOnly("/ws/acme-web"), ["/ws/acme-web"]);
  console.log("ok - clicking a repo name shows only that repo");
}
{
  assert.deepStrictEqual(toggleRepo(null, "/ws/acme-web", all), ["/ws/acme-api", "/ws/acme-libs"], "unticking from All keeps the rest");
  assert.deepStrictEqual(toggleRepo(["/ws/acme-api"], "/ws/acme-web", all), ["/ws/acme-api", "/ws/acme-web"], "ticking adds, in repo order");
  assert.strictEqual(toggleRepo(["/ws/acme-api", "/ws/acme-libs"], "/ws/acme-web", all), null, "ticking the last one back is All");
  assert.deepStrictEqual(toggleRepo(["/ws/acme-api"], "/ws/acme-api", all), [], "unticking the only one is None");
  console.log("ok - checkboxes and Ctrl/Cmd-click toggle membership");
}
{
  assert.ok(isChecked(null, "/ws/acme-api"));
  assert.ok(isChecked(["/ws/acme-api"], "/ws/acme-api") && !isChecked(["/ws/acme-api"], "/ws/acme-web"));
  console.log("ok - isChecked treats null as every repo");
}
{
  assert.deepStrictEqual(visibleRepos(repos, "").map((r) => r.name), ["acme-api", "acme-libs", "acme-web"]);
  assert.deepStrictEqual(visibleRepos(repos, " LIB ").map((r) => r.name), ["acme-libs"]);
  assert.deepStrictEqual(visibleRepos(repos, "zzz"), []);
  console.log("ok - the repo search narrows the list by name, case-insensitively");
}
{
  assert.strictEqual(DEFAULT_REPO_PANE_WIDTH, 190);
  assert.strictEqual(clampPaneWidth(40, 1400), 120, "never narrower than 120px");
  assert.strictEqual(clampPaneWidth(900, 1400), 480, "never wider than 480px");
  assert.strictEqual(clampPaneWidth(400, 600), 300, "always leaves 300px for the Log");
  assert.strictEqual(clampPaneWidth(Number.NaN, 1400), 190, "a corrupt saved width falls back to the default");
  console.log("ok - the repo pane width is clamped to a usable range");
}
{
  const names = ["acme-api", "acme-libs", "acme-web", "acme-svc-01", "acme-svc-10", "acme-svc-11", "web-acme-tools"].map((name) => ({ id: `/ws/${name}`, name }));
  const q = (query: string) => visibleRepos(names, query).map((r) => r.name);
  assert.deepStrictEqual(q("aw"), ["acme-web"], "letters must appear in order");
  assert.deepStrictEqual(q("svc1"), ["acme-svc-10", "acme-svc-11", "acme-svc-01"], "scattered letters match; tighter runs rank higher");
  assert.deepStrictEqual(q("web"), ["web-acme-tools", "acme-web"], "a prefix match ranks first, then a word-start match");
  assert.deepStrictEqual(q("LBS"), ["acme-libs"], "case-insensitive");
  assert.deepStrictEqual(q("zq"), [], "letters out of order or missing do not match");
  assert.deepStrictEqual(q(""), names.map((r) => r.name), "empty query keeps workspace order");
  assert.deepStrictEqual(fuzzyMatch("aw", "acme-web")?.positions, [0, 5], "positions of the matched letters, for highlighting");
  assert.strictEqual(fuzzyMatch("wa", "acme-web"), null);
  console.log("ok - repo search is fuzzy: in-order letters, word starts and runs rank higher");
}
{
  const w = new PaneWidth();
  assert.strictEqual(w.set(250, 1400), 250, "the width the user dragged to");
  assert.strictEqual(w.fit(200), 120, "a squeezed Log (or a collapse) shows less");
  assert.strictEqual(w.fit(1400), 250, "and the user's width comes back when there is room again");
  assert.strictEqual(w.set(40, 1400), 120, "a drag is still clamped");
  assert.strictEqual(w.fit(1400), 120, "and what it clamped to is what the user chose");
  console.log("ok - resizing never forgets the pane width the user chose");
}
{
  const repos = [{ id: "/ws/acme-web", name: "acme-web", root: "/ws/acme-web" }, { id: "/ws/acme-api", name: "acme-api", root: "/ws/acme-api" }, { id: "/ws/acme-libs", name: "acme-libs", root: "/ws/acme-libs" }];
  const backend = { name: "backend", ids: ["/ws/acme-api", "/ws/acme-libs"], missing: [] };
  const kinds = (rows: PaneRow[]) => rows.map((r) => (r.kind === "profile" ? `profile:${r.profile.name}${r.active ? "*" : ""}` : r.kind === "repo" ? r.name : "all"));
  assert.deepStrictEqual(kinds(paneRows(repos, "", [backend], null)), ["all", "profile:backend", "acme-web", "acme-api", "acme-libs"]);
  assert.deepStrictEqual(kinds(paneRows(repos, "", [backend], backend.ids)), ["all", "profile:backend*", "acme-web", "acme-api", "acme-libs"], "active: the ticks are the profile");
  assert.deepStrictEqual(kinds(paneRows(repos, "", [backend], ["/ws/acme-web"])), ["all", "profile:backend", "acme-web", "acme-api", "acme-libs"], "no save row: saving is in the menus");
  assert.deepStrictEqual(kinds(paneRows(repos, "", [], ["/ws/acme-web"])), ["all", "acme-web", "acme-api", "acme-libs"]);
  assert.deepStrictEqual(kinds(paneRows(repos, "api", [backend], ["/ws/acme-web"])), ["all", "acme-api"], "searching repositories hides profiles");
  console.log("ok - paneRows: All, profiles, repositories");
}
{
  const repos = ["acme-web", "acme-api", "acme-libs"].map((name) => ({ id: `/w/${name}`, root: `/w/${name}`, name }));
  const at = (rows: readonly { key: string }[], name: string) => rows.findIndex((r) => r.key === repoTreeKey(`/w/${name}`));
  const before = treeRows(repos, "", [], null, new Map(), DEFAULT_BRANCH_SIDEBAR);
  // The marks arrive after the cursor went to acme-libs: acme-api stopped in a merge, its row inserted above.
  const after = withOperations(before, new Map([["/w/acme-api", { operation: "merge" as const, conflicts: 0 }]]));
  assert.strictEqual(after[at(before, "acme-libs")].kind, "operation", "the cursor's old index is now the stopped merge's row");
  assert.strictEqual(keptCursor(before, at(before, "acme-libs"), after), at(after, "acme-libs"), "the cursor stays on acme-libs");
  assert.strictEqual(keptCursor(before, at(before, "acme-api"), after), at(after, "acme-api"));
  assert.strictEqual(keptCursor(after, at(after, "acme-libs"), before), at(before, "acme-libs"), "and when the row above goes");
  // Its row left: the nearest row above that stayed, never a stopped operation's.
  const gone = after.filter((r) => r.key !== repoTreeKey("/w/acme-libs"));
  assert.strictEqual(keptCursor(after, at(after, "acme-libs"), gone), at(gone, "acme-api"), "acme-libs gone: acme-api, not its merge row");
  const top = [{ key: "x", kind: "repo" }, { key: "op", kind: "operation" }, { key: "y", kind: "repo" }];
  assert.strictEqual(keptCursor(top, 0, top.slice(1)), 1, "nothing above: the nearest row below that is not an operation");
  assert.strictEqual(keptCursor([], 0, after), 0, "a first render starts at the top");
  assert.strictEqual(keptCursor(after, 2, []), 0);
  console.log("ok - the Repo List's cursor stays on its row when rows arrive above it, and never lands on a stopped merge");
}
