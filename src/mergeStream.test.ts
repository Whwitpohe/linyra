import * as assert from "assert";
import { compareCommits, copyTopoState, takeReady, takeTopoReady, type RepoProgress, type TopoMergeState } from "./mergeStream";
import { commitKey, type Commit } from "./types";

let serial = 0;
const mk = (repoId: string, time: number): Commit => ({
  repoId, time, sha: (++serial).toString(16).padStart(40, "0"),
  author: "dana", email: "dana@example.com", subject: `${repoId}@${time}`, parents: [],
});
const prog = (pending: Commit[], exhausted: boolean): RepoProgress => ({ fetched: pending.length, pending, exhausted });

// ── Ordering: newest first across repos; exhausted repos flush completely ──
{
  const p = new Map([["web", prog([mk("web", 50), mk("web", 10)], true)], ["api", prog([mk("api", 40), mk("api", 20)], true)]]);
  assert.deepStrictEqual(takeReady(p).map((c) => c.time), [50, 40, 20, 10]);
  assert.ok([...p.values()].every((x) => x.pending.length === 0));
  console.log("ok - merges repos newest first; exhausted repos hold nothing back");
}

// ── Equal timestamps: by repository, and in git's order within one ─────────
{
  const a = { ...mk("web", 7), sha: "0".repeat(40) };
  const b = { ...mk("api", 7), sha: "f".repeat(40) };
  const rows = takeReady(new Map([["web", prog([a], true)], ["api", prog([b], true)]]));
  assert.deepStrictEqual(rows.map((c) => c.sha), [b.sha, a.sha]);
  assert.ok(compareCommits(b, a) < 0);
  // A child and its parent made in the same second: git lists the child first; the SHAs must not swap them.
  const child = { ...mk("web", 9), sha: "f".repeat(40) };
  const parent = { ...mk("web", 9), sha: "0".repeat(40) };
  const older = mk("web", 3);
  const same = takeReady(new Map([["web", prog([child, parent, older], true)], ["api", prog([mk("api", 9)], true)]]));
  assert.deepStrictEqual(same.filter((c) => c.repoId === "web").map((c) => c.sha), [child.sha, parent.sha, older.sha]);
  console.log("ok - equal timestamps: ordered by repository, and in git's order within one");
}

// ── Empty input ─────────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(takeReady(new Map()), []);
  assert.deepStrictEqual(takeReady(new Map([["web", prog([], true)]])), []);
  console.log("ok - nothing pending yields nothing");
}

// ── Horizon: rows older than a repo that may have more are held back ───────
{
  const web = prog([mk("web", 900), mk("web", 500)], false);
  const api = prog([mk("api", 800), mk("api", 400)], true);
  const rows = takeReady(new Map([["web", web], ["api", api]]));
  assert.deepStrictEqual(rows.map((c) => c.time), [900, 800, 500]);
  assert.deepStrictEqual(api.pending.map((c) => c.time), [400], "held back for a later page, not dropped");
  assert.deepStrictEqual(web.pending, []);
  console.log("ok - rows older than the horizon stay pending");
}

// ── A backwards-dated commit sinks to its date instead of setting the pace ─
{
  const skewed = prog([mk("web", 100), mk("web", 1)], false); // walk order: child with an old clock
  const busy = prog([mk("api", 90), mk("api", 80)], false);
  const rows = takeReady(new Map([["web", skewed], ["api", busy]]));
  assert.deepStrictEqual(rows.map((c) => c.time), [100, 90, 80]);
  assert.deepStrictEqual(skewed.pending.map((c) => c.time), [1]);
  console.log("ok - a skewed commit waits in pending; nothing is lost");
}

{
  assert.ok(commitKey(mk("a", 1)) !== commitKey(mk("b", 1)));
}

{
  const child = mk("web", 10), parent = mk("web", 100), other = mk("api", 50);
  const rows = takeTopoReady(new Map([["web", prog([child, parent], true)], ["api", prog([other], true)]]));
  assert.deepStrictEqual(rows, [other, child, parent], "date chooses between repository heads without reversing any repository's Git walk");
  const web = prog([child], false), api = prog([other], true);
  const progress = new Map([["web", web], ["api", api]]);
  assert.deepStrictEqual(takeTopoReady(progress), [other, child]);
  api.pending.push(mk("api", 5));
  assert.deepStrictEqual(takeTopoReady(progress), [], "a missing page must be read before draining another repository");
  web.pending.push(parent);
  web.exhausted = true;
  assert.deepStrictEqual(takeTopoReady(progress).map((c) => c.time), [100, 5]);
  console.log("ok - topological merge preserves parent order, pauses for paging and uses dates between repositories");
}

const node = (sha: string, time: number, parents: string[] = [], repoId = "web"): Commit => ({ ...mk(repoId, time), sha, parents });
{
  const root = node("root", 50), main = node("main", 800, [root.sha]);
  const b1 = node("b1", 100, [root.sha]), b2 = node("b2", 200, [b1.sha]);
  const merge = node("merge", 1000, [main.sha, b2.sha]), other = node("other", 900, [], "api");
  const rows = takeTopoReady(new Map([["web", prog([merge, b2, b1, main, root], true)], ["api", prog([other], true)]]));
  assert.deepStrictEqual(rows.map((c) => c.sha), ["merge", "b2", "b1", "other", "main", "root"]);
  console.log("ok - incoming history stays directly below its merge instead of being split by another repo's newer dates");
}
{
  const root = node("root", 0), main = node("main", 900, [root.sha]), side = node("side", 400, [root.sha]);
  const b1 = node("b1", 100, [root.sha]), b2 = node("b2", 200, [b1.sha]);
  const nested = node("nested", 500, [side.sha, b2.sha]), merge = node("merge", 1000, [main.sha, nested.sha]);
  const rows = takeTopoReady(new Map([["web", prog([merge, nested, b2, b1, side, main, root], true)], ["api", prog([node("other", 950, [], "api")], true)]]));
  assert.deepStrictEqual(rows.map((c) => c.sha), ["merge", "nested", "b2", "b1", "side", "other", "main", "root"]);
  console.log("ok - nested incoming merges retain their outer merge's boundary");
}
{
  const root = node("root", 0), main = node("main", 900, [root.sha]);
  const b = node("b", 100, [root.sha]), c = node("c", 200, [root.sha]);
  const merge = node("merge", 1000, [main.sha, b.sha, c.sha]);
  const rows = takeTopoReady(new Map([["web", prog([merge, c, b, main, root], true)], ["api", prog([node("other", 950, [], "api")], true)]]));
  assert.deepStrictEqual(rows.map((c) => c.sha), ["merge", "c", "b", "other", "main", "root"]);
  console.log("ok - all octopus incoming sides remain grouped before the mainline resumes");
}
{
  const merge = node("merge", 1000, ["main", "b2"]), b2 = node("b2", 200, ["b1"]);
  const web = prog([merge, b2], false), other = node("other", 900, [], "api");
  const progress = new Map([["web", web], ["api", prog([other], true)]]), state: TopoMergeState = {};
  assert.deepStrictEqual(takeTopoReady(progress, state).map((c) => c.sha), ["merge", "b2"]);
  const before = [...state.part!.incoming!];
  const copy = copyTopoState(state);
  web.pending.push(node("b1", 100, ["root"]), node("main", 800, ["root"]), node("root", 0)); web.exhausted = true;
  assert.deepStrictEqual(takeTopoReady(progress, copy).map((c) => c.sha), ["b1", "other", "main", "root"]);
  assert.deepStrictEqual([...state.part!.incoming!], before, "an aborted/new page cannot mutate the previous page's continuation");
  console.log("ok - merge-side priority crosses page boundaries and query copies isolate mutable frontier state");
}
{
  const root = node("root", 0), b = node("b", 100, [root.sha]), main = node("main", 800, [b.sha]);
  const merge = node("merge", 1000, [main.sha, b.sha]);
  const rows = takeTopoReady(new Map([["web", prog([merge, main, b, root], true)], ["api", prog([node("other", 900, [], "api")], true)]]));
  assert.deepStrictEqual(rows.map((c) => c.sha), ["merge", "other", "main", "b", "root"], "an incoming ancestor cannot jump above a not-yet-shown child on the mainline");
  const filtered = takeTopoReady(new Map([["web", prog([merge, node("filtered-parent", 100), main, root], true)], ["api", prog([node("other", 900, [], "api")], true)]]));
  assert.strictEqual(filtered[1].sha, "other", "a missing/filtered parent ends the group instead of attaching unrelated rows");
  console.log("ok - shared ancestry and filtered gaps never violate the original topological walk");
}
{
  const old = node("old", 0), recent = node("recent", 4 * 86400, [old.sha]), other = node("other", 3 * 86400, [], "api");
  assert.deepStrictEqual(takeTopoReady(new Map([["web", prog([recent, old], true)], ["api", prog([other], true)]])).map((c) => c.sha), ["recent", "other", "old"]);
  const dated = takeReady(new Map([["web", prog([node("merge", 1000, ["a", "b"]), node("b", 100)], true)], ["api", prog([node("other", 900, [], "api")], true)]]));
  assert.deepStrictEqual(dated.map((c) => c.sha), ["merge", "other", "b"]);
  console.log("ok - long inactive gaps release other repos and chronological mode retains date-only ordering");
}
