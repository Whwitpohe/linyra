import * as assert from "assert";
import { aheadBehindArgs, behindRepos, fetchArgs, fetchProgress, fetchSummary, parseAheadBehind, pullArgs, pullPlan, pullReason, pullSummary, syncLabel } from "./upstream";

{
  assert.deepStrictEqual(aheadBehindArgs(), ["rev-list", "--left-right", "--count", "HEAD...@{upstream}", "--"], "local refs only: no fetch");
  assert.deepStrictEqual(parseAheadBehind("2\t3\n"), { ahead: 2, behind: 3 }, "left is HEAD's own commits, right the upstream's");
  assert.deepStrictEqual(parseAheadBehind("0\t0\n"), { ahead: 0, behind: 0 });
  assert.strictEqual(parseAheadBehind("fatal: no upstream configured\n"), null, "anything else: nothing to show");
  assert.strictEqual(parseAheadBehind(""), null);
  console.log("ok - ahead/behind its upstream, from git rev-list --left-right --count");
}
{
  assert.strictEqual(syncLabel({ ahead: 0, behind: 0 }), null, "up to date: no badge");
  assert.deepStrictEqual(syncLabel({ ahead: 0, behind: 3 }), { text: "↓3", title: "3 commits to pull from its upstream", behind: true });
  assert.deepStrictEqual(syncLabel({ ahead: 1, behind: 0 }), { text: "↑1", title: "1 commit not pushed", behind: false });
  assert.deepStrictEqual(syncLabel({ ahead: 2, behind: 1 }), { text: "↓1 ↑2", title: "1 commit to pull from its upstream, 2 commits not pushed", behind: true });
  console.log("ok - the Repositories pane badge: ↓ to pull, ↑ not pushed");
}
{
  assert.deepStrictEqual(fetchArgs(false), ["fetch", "--quiet", "--recurse-submodules=no"], "the default remote, as VS Code's Fetch; submodules fetch on their own");
  assert.deepStrictEqual(fetchArgs(true), ["fetch", "--quiet", "--recurse-submodules=no", "--prune"], "git.pruneOnFetch");
  const sync = { "/ws/acme-api": { ahead: 0, behind: 3 }, "/ws/acme-libs": { ahead: 2, behind: 0 }, "/ws/acme-web": { ahead: 1, behind: 1 } };
  assert.deepStrictEqual(behindRepos(["/ws/acme-web", "/ws/acme-api", "/ws/acme-libs"], sync), ["/ws/acme-web", "/ws/acme-api"], "behind only (not merely ahead), in repo order");
  assert.deepStrictEqual(behindRepos(["/ws/acme-web"], {}), []);
  console.log("ok - Fetch All's arguments; the repositories behind their upstream");
}
{
  assert.strictEqual(fetchProgress(23, 68), "fetching 23/68…", "after the progress title, Linyra");
  assert.strictEqual(fetchSummary(68, 3), "Linyra: fetched 68 repositories · 3 behind their upstream");
  assert.strictEqual(fetchSummary(68, 1), "Linyra: fetched 68 repositories · 1 behind its upstream");
  assert.strictEqual(fetchSummary(1, 0), "Linyra: fetched 1 repository · nothing to pull");
  console.log("ok - Fetch All says how far it is, and what it found");
}
{
  assert.deepStrictEqual(pullArgs(), ["-c", "merge.autoStash=false", "-c", "submodule.recurse=false", "merge", "--ff-only", "--quiet", "@{upstream}"],
    "what the last fetch brought: never a merge commit; autostash off, or it would merge local changes in and write conflict markers");
  const sync = { a: { ahead: 0, behind: 3 }, b: { ahead: 2, behind: 0 }, c: { ahead: 1, behind: 4 }, d: { ahead: 0, behind: 1 } };
  assert.deepStrictEqual(pullPlan(["d", "c", "b", "a", "e"], sync), { pull: ["d", "a"], diverged: ["c"] }, "behind and not ahead: a fast-forward; both: diverged, left alone");
  assert.strictEqual(pullReason("error: Your local changes to the following files would be overwritten by merge:\n\tx.go"), "local changes to the same files");
  assert.strictEqual(pullReason("fatal: Not possible to fast-forward, aborting."), "it has diverged from its upstream");
  assert.strictEqual(pullReason("error: The following untracked working tree files would be overwritten by merge:\n\tnew.go"), "untracked files in the way");
  assert.strictEqual(pullReason("fatal: something else"), "fatal: something else");
  assert.strictEqual(pullSummary(14), "Linyra: pulled 14 repositories");
  assert.strictEqual(pullSummary(1), "Linyra: pulled 1 repository");
  console.log("ok - Pull All Behind: fast-forwards only, and says why it left one alone");
}
