// Times the Log webview's per-page rebuild (fold segments, fold projection, neighbor colors,
// graph layout) on a merged history shaped like dev/perf's 68-repository workspace. Dev-only.
//   npx esbuild dev/perf/webviewBench.ts --bundle --platform=node --outfile=out/perf/webviewBench.js && node out/perf/webviewBench.js
import { compareCommits } from "../../src/mergeStream";
import type { Commit } from "../../src/types";
import { linearSegments, projectFolds } from "../../src/webview/graphFoldModel";
import { indexParents, layoutGraph, type ParentIndex } from "../../src/webview/graphModel";
import { assignAccents, separateAdjacentAccents } from "../../src/webview/view";

const REPOS = 68;
const sha = (n: number) => n.toString(16).padStart(40, "0");
let serial = 0;
const commits: Commit[] = [];
const now = 1_790_000_000;
for (let r = 0; r < REPOS; r++) {
  const repoId = `/ws/acme-${r}`;
  const count = r === 0 ? 5633 : 100 + ((r * 37) % 120);
  let parent: string | undefined;
  let side: string | undefined;
  for (let i = 0; i < count; i++) {
    const id = sha(++serial);
    const time = now - Math.floor(((count - i) / count) * 60 * 86_400) + (r % 7) * 60;
    // Every 25th commit merges a two-commit side branch, so the graph has real lanes.
    const parents = parent ? (i % 25 === 0 && side ? [parent, side] : [parent]) : [];
    commits.push({ repoId, sha: id, time, author: i % 2 ? "rin" : "dana", email: "dana@example.com", subject: `change ${i}`, parents });
    if (i % 25 === 23) side = id; else parent = id;
  }
}
const all = commits.sort(compareCommits);
const repos = [...new Set(all.map((c) => c.repoId))].map((id) => ({ id, name: id.slice(4) }));
const base = assignAccents(repos);
const order = repos.map((r) => r.id);

function rebuild(rows: readonly Commit[]): Record<string, number> {
  const t: Record<string, number> = {};
  let s = performance.now();
  const segments = linearSegments(rows);
  t.segments = performance.now() - s; s = performance.now();
  const shown = projectFolds(rows, segments, new Set()).rows.map((row) => row.commit);
  t.folds = performance.now() - s; s = performance.now();
  const accents = separateAdjacentAccents(shown, base, order);
  t.colors = performance.now() - s; s = performance.now();
  layoutGraph(shown, accents);
  t.layout = performance.now() - s;
  t.total = t.segments + t.folds + t.colors + t.layout;
  return t;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const result: Record<string, Record<string, number>> = {};
for (const n of [1000, 5000, 10000, 20000]) {
  const rows = all.slice(0, n);
  for (let i = 0; i < 3; i++) rebuild(rows); // warm up
  const runs = Array.from({ length: 9 }, () => rebuild(rows));
  result[n] = Object.fromEntries(Object.keys(runs[0]).map((k) => [k, +median(runs.map((r) => r[k])).toFixed(1)]));
}
// Paging to the end 1,000 rows at a time, as the Log does: the parent index is extended per page.
function page(rows: readonly Commit[], index: ParentIndex | undefined): { ms: number; index: ParentIndex } {
  const s = performance.now();
  const next = indexParents(rows, index);
  const segments = linearSegments(rows, next);
  const shown = projectFolds(rows, segments, new Set()).rows.map((row) => row.commit);
  layoutGraph(shown, separateAdjacentAccents(shown, base, order), next);
  return { ms: performance.now() - s, index: next };
}
/** Paging to the end: each page from scratch (as before 1.5.1), or extending the parent index. */
function pageThrough(extend: boolean): { total: number; last: number } {
  let total = 0, last = 0, index: ParentIndex | undefined;
  let shownSoFar: Commit[] = [];
  for (let n = 1000; shownSoFar.length < all.length; n += 1000) {
    shownSoFar = shownSoFar.concat(all.slice(shownSoFar.length, n)); // the webview appends, keeping the objects
    if (extend) { const r = page(shownSoFar, index); index = r.index; last = r.ms; } else last = rebuild(shownSoFar).total;
    total += last;
  }
  return { total: +total.toFixed(0), last: +last.toFixed(1) };
}
pageThrough(true); pageThrough(false); // warm up
const runs = (extend: boolean) => Array.from({ length: 5 }, () => pageThrough(extend));
const med = (xs: { total: number; last: number }[]) => ({ msTotal: median(xs.map((x) => x.total)), msLastPage: median(xs.map((x) => x.last)) });
console.log(JSON.stringify({ rowsAvailable: all.length, msPerRebuild: result, pagingToEnd: { fromScratch: med(runs(false)), extended: med(runs(true)) } }, null, 1));
