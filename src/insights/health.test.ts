import * as assert from "assert";
import { configureI18n } from "../i18n";
import { assess, commandText, confirmText, effectiveConfig, gitBool, maintenanceStart, THRESHOLDS, writePlan, type HealthCheck, type HealthFacts } from "./health";
import { parseConfig, type ObjectCounts } from "./parse";

configureI18n("en");
const o = { number: (n: number) => n.toLocaleString("en"), bytes: (n: number) => `${Math.round(n / 1024)} KiB`, platform: "win32", insensitive: true };
const objects = (loose: number, packs: number, packKiB = 1000): ObjectCounts => ({ loose, looseKiB: 0, inPack: 5000, packs, packKiB, prunePackable: 0, garbage: 0 });
const facts = (extra: Partial<HealthFacts> = {}): HealthFacts => ({ root: "C:/work/acme-web", commitGraph: true, objects: objects(10, 1), tracked: 500, config: parseConfig(""), ...extra });
const check = (row: { checks: HealthCheck[] }, id: HealthCheck["id"]) => row.checks.find((c) => c.id === id)!;
const repo = { id: "/work/acme-web", name: "acme-web" };

// ── git's booleans and the settings as git applies them ───────────────────
{
  assert.deepStrictEqual([null, "true", "Yes", "on", "1", "false", "no", "OFF", "0", "", "keep", undefined].map(gitBool), [true, true, true, true, true, false, false, false, false, false, undefined, undefined]);
  const c = effectiveConfig(parseConfig("core.untrackedcache true\ncore.untrackedcache false\nfeature.manyfiles\nmaintenance.repo c:\\Work\\acme-web\\\n"), "C:/work/acme-web", true);
  assert.deepStrictEqual(c.untrackedCache, { on: false, source: "set" }, "the last value wins");
  assert.strictEqual(c.manyFiles, true, "a key without a value is true");
  assert.strictEqual(c.registered, true, "maintenance.repo matches the root, whatever its slashes and case on Windows");
  assert.strictEqual(effectiveConfig(parseConfig("maintenance.repo C:/WORK/acme-web"), "C:/work/acme-web", false).registered, false, "case matters on Linux");
  assert.deepStrictEqual(effectiveConfig(parseConfig("feature.manyfiles true\ncore.untrackedcache keep"), "/r", false).untrackedCache, { on: true, source: "manyFiles" }, "feature.manyFiles turns it on by default");
  assert.deepStrictEqual(effectiveConfig(parseConfig("core.fsmonitor .git/hooks/query-watchman"), "/r", false).fsmonitor, { on: true, hook: ".git/hooks/query-watchman" });
  assert.deepStrictEqual(effectiveConfig(parseConfig("core.fsmonitor true"), "/r", false).fsmonitor, { on: true });
  console.log("ok - Health reads git's booleans and settings as git applies them");
}

// ── Thresholds: a small healthy repository has nothing to do ──────────────
{
  const row = assess(repo, facts(), o);
  assert.strictEqual(row.suggestions, 0);
  assert.deepStrictEqual(row.optimize, []);
  assert.deepStrictEqual(row.checks.map((c) => c.id), ["commitGraph", "objects", "tracked", "untrackedCache", "fsmonitor", "manyFiles", "maintenance"]);
  assert.strictEqual(check(row, "tracked").value, "500 files");
  assert.strictEqual(check(row, "untrackedCache").advice, "Not needed under 10,000 tracked files.");
  assert.strictEqual(check(row, "objects").value, "10 loose · 1 pack · 1000 KiB");
  assert.strictEqual(check(assess(repo, facts({ objects: objects(0, 3) }), o), "objects").value, "0 loose · 3 packs · 1000 KiB");
  assert.strictEqual(check(row, "maintenance").action?.kind, "copy", "unregistered: its command can be copied, never run");

  const small = assess(repo, facts({ commitGraph: false, objects: { ...objects(10, 1), inPack: 100 } }), o);
  assert.deepStrictEqual([check(small, "commitGraph").status, check(small, "commitGraph").action?.recommended], ["ok", false], "a tiny repository needs no commit-graph, but may write one");
  console.log("ok - a small, healthy repository has nothing recommended");
}

// ── Each threshold, just under and at it ───────────────────────────────────
{
  const T = THRESHOLDS;
  const at = (tracked: number) => assess(repo, facts({ tracked }), o);
  assert.strictEqual(check(at(T.untrackedCache - 1), "untrackedCache").status, "ok");
  const uc = check(at(T.untrackedCache), "untrackedCache");
  assert.deepStrictEqual([uc.status, uc.action], ["suggest", { kind: "config", key: "core.untrackedCache", value: true, label: "Turn On", recommended: true }]);
  assert.strictEqual(check(at(T.fsmonitor - 1), "fsmonitor").status, "ok");
  assert.strictEqual(check(at(T.fsmonitor), "fsmonitor").status, "suggest");
  const linux = assess(repo, facts({ tracked: T.fsmonitor }), { ...o, platform: "linux" });
  assert.deepStrictEqual([check(linux, "fsmonitor").status, check(linux, "fsmonitor").action], ["info", undefined], "Linux: git has no built-in monitor");
  assert.strictEqual(check(at(T.manyFiles - 1), "manyFiles").status, "ok");
  assert.ok(check(at(T.manyFiles), "manyFiles").advice.includes("libgit2"), "manyFiles warns about older tools");
  const big = at(T.manyFiles);
  assert.strictEqual(big.suggestions, 4, "untracked cache, monitor, many files, maintenance");
  assert.deepStrictEqual(big.optimize, [
    { kind: "config", key: "core.untrackedCache", value: true }, { kind: "config", key: "core.fsmonitor", value: true }, { kind: "config", key: "feature.manyFiles", value: true },
  ], "Optimize writes the settings; maintenance start is the user's to run");

  const loose = assess(repo, facts({ objects: objects(T.looseObjects, T.packs) }), o);
  assert.deepStrictEqual(check(loose, "objects").action, { kind: "maintenance", tasks: ["loose-objects", "incremental-repack"], label: "Run Maintenance…", recommended: true });
  assert.strictEqual(check(assess(repo, facts({ objects: objects(T.looseObjects - 1, T.packs - 1) }), o), "objects").status, "ok");
  const graph = assess(repo, facts({ commitGraph: false }), o);
  assert.deepStrictEqual([check(graph, "commitGraph").status, graph.optimize], ["suggest", [{ kind: "commitGraph" }]]);
  const packs = assess(repo, facts({ objects: objects(0, 1, T.maintenancePackKiB) }), o);
  assert.strictEqual(check(packs, "maintenance").status, "suggest", "100 MB of packs: maintenance is worth it");

  const on = assess(repo, facts({ tracked: T.manyFiles, config: parseConfig(`core.untrackedcache true\ncore.fsmonitor true\nfeature.manyfiles true\nmaintenance.repo C:/work/acme-web`) }), o);
  assert.strictEqual(on.suggestions, 0);
  assert.deepStrictEqual(check(on, "untrackedCache").action, { kind: "config", key: "core.untrackedCache", value: false, label: "Turn Off", recommended: false }, "on: the button turns it off");
  assert.strictEqual(check(on, "maintenance").action, undefined);
  const implied = assess(repo, facts({ tracked: T.manyFiles, config: parseConfig("feature.manyfiles true") }), o);
  assert.deepStrictEqual([check(implied, "untrackedCache").value, check(implied, "untrackedCache").action], ["On (feature.manyFiles)", undefined], "implied by feature.manyFiles: turn that off instead");

  const failed = assess(repo, { root: "/r", commitGraph: undefined, objects: undefined, tracked: undefined, config: undefined }, o);
  assert.ok(failed.checks.every((c) => c.status === "unknown" && c.value === "—"));
  assert.strictEqual(failed.checks.length, 7);
  console.log("ok - each recommendation starts at its threshold, and Optimize runs only what writes");
}

// ── What a write runs, and the confirmation that says so ──────────────────
{
  assert.strictEqual(commandText(writePlan({ kind: "commitGraph" })!), "git commit-graph write --reachable");
  assert.deepStrictEqual(writePlan({ kind: "maintenance", tasks: ["loose-objects", "pack-refs"] })!.args, ["maintenance", "run", "--task=loose-objects", "--task=pack-refs"]);
  assert.ok(writePlan({ kind: "maintenance", tasks: ["gc"] })!.writes.includes("unreachable"), "gc says it deletes");
  assert.strictEqual(writePlan({ kind: "maintenance", tasks: [] }), undefined);
  assert.deepStrictEqual(writePlan({ kind: "config", key: "core.fsmonitor", value: false })!.args, ["config", "--local", "core.fsmonitor", "false"]);
  assert.strictEqual(writePlan({ kind: "copy" }), undefined);
  assert.strictEqual(maintenanceStart("C:\\work\\acme web"), 'git -C "C:\\work\\acme web" maintenance start');

  const one = confirmText([{ name: "acme-web", plans: [writePlan({ kind: "commitGraph" })!] }]);
  assert.strictEqual(one.message, "Write the commit-graph in acme-web?");
  assert.strictEqual(one.button, "Write Commit-Graph");
  assert.ok(one.detail.includes("acme-web:\n  git commit-graph write --reachable  (writes .git/objects/info/commit-graph)"), one.detail);
  const config = confirmText([{ name: "acme-api", plans: [writePlan({ kind: "config", key: "core.untrackedCache", value: true })!] }]);
  assert.deepStrictEqual([config.message, config.button], ["Set core.untrackedCache to true in acme-api?", "Turn On"]);
  const many = confirmText([{ name: "acme-web", plans: [writePlan({ kind: "commitGraph" })!, writePlan({ kind: "config", key: "feature.manyFiles", value: true })!] }, { name: "acme-libs", plans: [] },
    { name: "acme-api", plans: [writePlan({ kind: "maintenance", tasks: ["loose-objects"] })!] }]);
  assert.deepStrictEqual([many.message, many.button], ["Optimize 2 repositories?", "Optimize"], "a repository with nothing to run is not counted");
  assert.ok(many.detail.includes("acme-api:\n  git maintenance run --task=loose-objects") && !many.detail.includes("acme-libs"));
  configureI18n("zh-cn", { "Write the commit-graph in {0}?": "在 {0} 中写入 commit-graph？" });
  assert.strictEqual(confirmText([{ name: "acme-web", plans: [writePlan({ kind: "commitGraph" })!] }]).message, "在 acme-web 中写入 commit-graph？");
  configureI18n("en");
  console.log("ok - every write is one exact git command, and its confirmation names the command and what it writes");
}
