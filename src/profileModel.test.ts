import * as assert from "assert";
import { activeProfiles, deleteProfile, nameProblem, profileFilter, profileNames, readProfiles, renameProfile, repoKey, resolveProfiles, saveProfile, setMembership, showSaveRow } from "./profileModel";

{
  assert.deepStrictEqual(readProfiles(undefined), {});
  assert.deepStrictEqual(readProfiles("backend"), {}, "not an object");
  assert.deepStrictEqual(readProfiles(["acme-api"]), {}, "an array is not a map");
  assert.deepStrictEqual(
    readProfiles({ backend: ["acme-api", 3, "", " acme-libs ", "acme-api"], "  ": ["acme-web"], frontend: "acme-web", " ops ": [] }),
    { backend: ["acme-api", "acme-libs"], ops: [] },
    "bad entries and blank names are dropped, names and entries trimmed, duplicates once",
  );
  assert.deepStrictEqual(profileNames({ frontend: [], Backend: [], api: [] }), ["api", "Backend", "frontend"], "sorted ignoring case");
  console.log("ok - readProfiles is lenient; profileNames sorts ignoring case");
}
{
  const one = [{ name: "ws", path: "/home/dana/ws" }];
  assert.strictEqual(repoKey("/home/dana/ws/acme-api", one), "acme-api");
  assert.strictEqual(repoKey("/home/dana/ws/services/acme-api/", one), "services/acme-api", "nested, trailing slash");
  assert.strictEqual(repoKey("/home/dana/ws", one), ".", "the workspace folder itself");
  assert.strictEqual(repoKey("/home/dana/wsx/acme-api", one), "/home/dana/wsx/acme-api", "a sibling folder with the same prefix is outside");
  const two = [{ name: "web", path: "/src/web" }, { name: "api", path: "/src/api" }];
  assert.strictEqual(repoKey("/src/api/acme-api", two), "api/acme-api", "multi-root: the folder's name first");
  assert.strictEqual(repoKey("/src/web", two), "web", "multi-root: a folder that is a repository");
  const win = [{ name: "ws", path: "C:\\Users\\dana\\ws" }];
  assert.strictEqual(repoKey("c:\\users\\dana\\ws\\acme-web", win, true), "acme-web", "Windows: separators and case");
  console.log("ok - repoKey: relative to the workspace folder, '/' separators, multi-root names");
}
{
  const repos = [{ id: "/ws/acme-web", key: "acme-web" }, { id: "/ws/acme-api", key: "acme-api" }, { id: "/ws/acme-libs", key: "acme-libs" }];
  const all = repos.map((r) => r.id);
  const resolved = resolveProfiles({ frontend: ["acme-web", "acme-libs"], backend: ["acme-api", "acme-libs", "acme-jobs"], gone: ["acme-jobs"], every: ["acme-web", "acme-api", "acme-libs"] }, repos);
  assert.deepStrictEqual(resolved.map((p) => [p.name, p.ids, p.missing]), [
    ["backend", ["/ws/acme-api", "/ws/acme-libs"], ["acme-jobs"]],
    ["every", all, []],
    ["frontend", ["/ws/acme-web", "/ws/acme-libs"], []],
    ["gone", [], ["acme-jobs"]],
  ], "ids in Repo List order; missing entries kept aside");
  const [backend, every, , gone] = resolved;
  assert.deepStrictEqual(activeProfiles(resolved, ["/ws/acme-libs", "/ws/acme-api"], all), ["backend"], "same set, any order");
  assert.deepStrictEqual(activeProfiles(resolved, ["/ws/acme-api"], all), [], "a subset is not the profile");
  assert.deepStrictEqual(activeProfiles(resolved, null, all), ["every"], "All matches a profile of every repository");
  assert.deepStrictEqual(activeProfiles(resolved, [], all), [], "an empty profile is never active");
  assert.deepStrictEqual(profileFilter(backend, all), ["/ws/acme-api", "/ws/acme-libs"]);
  assert.strictEqual(profileFilter(every, all), null, "every repository is All");
  assert.deepStrictEqual(profileFilter(gone, all), [], "nothing found ticks nothing");
  assert.strictEqual(showSaveRow(resolved, null, all), false, "All: nothing to save");
  assert.strictEqual(showSaveRow(resolved, [], all), false, "nothing ticked");
  assert.strictEqual(showSaveRow(resolved, ["/ws/acme-api", "/ws/acme-libs"], all), false, "already a profile");
  assert.strictEqual(showSaveRow(resolved, ["/ws/acme-web"], all), true);
  assert.strictEqual(showSaveRow([], ["/ws/acme-web"], all), true, "also with no profiles yet");
  console.log("ok - resolveProfiles, activeProfiles, profileFilter, showSaveRow");
}
{
  const p = { backend: ["acme-api"], frontend: ["acme-web", "acme-libs"] };
  assert.strictEqual(nameProblem(p, "  "), "Enter a name.");
  assert.strictEqual(nameProblem(p, "frontend"), 'A profile named "frontend" already exists.');
  assert.strictEqual(nameProblem(p, "Frontend"), 'A profile named "frontend" already exists.', "case does not make a new name");
  assert.strictEqual(nameProblem(p, "Backend", "backend"), undefined, "renaming to its own name in another case is fine");
  assert.strictEqual(nameProblem(p, "ops"), undefined);
  assert.deepStrictEqual(saveProfile(p, " ops ", ["acme-api", "acme-api"]), { ...p, ops: ["acme-api"] });
  assert.deepStrictEqual(saveProfile(p, "backend", ["acme-libs"]).backend, ["acme-libs"], "replaces");
  assert.deepStrictEqual(Object.keys(renameProfile(p, "backend", "api")), ["api", "frontend"], "keeps its place");
  assert.deepStrictEqual(renameProfile(p, "backend", "api").api, ["acme-api"]);
  assert.strictEqual(renameProfile(p, "nope", "api"), p, "unknown: unchanged");
  assert.deepStrictEqual(deleteProfile(p, "backend"), { frontend: ["acme-web", "acme-libs"] });
  assert.deepStrictEqual(p.backend, ["acme-api"], "edits never mutate");
  assert.deepStrictEqual(setMembership(p, "acme-libs", ["backend"]), { backend: ["acme-api", "acme-libs"], frontend: ["acme-web"] }, "added where ticked, removed where not");
  assert.deepStrictEqual(setMembership(p, "acme-api", ["backend"]), p, "already right: same lists");
  console.log("ok - nameProblem and the edits");
}
