import * as assert from "assert";
import { clampPaneWidth, DEFAULT_REPO_PANE_WIDTH, PaneWidth, fuzzyMatch, isChecked, pickOnly, toggleRepo, visibleRepos, paneRows, type PaneRow } from "./repoPaneModel";

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
  const kinds = (rows: PaneRow[]) => rows.map((r) => (r.kind === "profile" ? `profile:${r.profile.name}${r.active ? "*" : ""}` : r.kind === "save" ? `save:${r.count}` : r.kind === "repo" ? r.name : "all"));
  assert.deepStrictEqual(kinds(paneRows(repos, "", [backend], null)), ["all", "profile:backend", "acme-web", "acme-api", "acme-libs"]);
  assert.deepStrictEqual(kinds(paneRows(repos, "", [backend], backend.ids)), ["all", "profile:backend*", "acme-web", "acme-api", "acme-libs"], "active: the ticks are the profile");
  assert.deepStrictEqual(kinds(paneRows(repos, "", [backend], ["/ws/acme-web"])), ["all", "profile:backend", "save:1", "acme-web", "acme-api", "acme-libs"], "a new selection can be saved");
  assert.deepStrictEqual(kinds(paneRows(repos, "", [], ["/ws/acme-web"])), ["all", "save:1", "acme-web", "acme-api", "acme-libs"], "the way in with no profiles yet");
  assert.deepStrictEqual(kinds(paneRows(repos, "api", [backend], ["/ws/acme-web"])), ["all", "acme-api"], "searching repositories hides profiles");
  console.log("ok - paneRows: All, profiles, the save row, repositories");
}
