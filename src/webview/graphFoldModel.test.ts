import * as assert from "assert";
import type { Commit } from "../types";
import { commitKey } from "../types";
import { linearSegments, projectFolds, segmentNodes } from "./graphFoldModel";
import { layoutGraph } from "./graphModel";

const c = (sha: string, parents: string[], repoId = "acme-api"): Commit => ({ repoId, sha, parents, time: 0, author: "dana", email: "dana@example.com", subject: sha });
const chain = (count: number, repoId = "acme-api") => Array.from({ length: count }, (_, i) => c(String(i), i === count - 1 ? [] : [String(i + 1)], repoId));
const accents = new Map([["acme-api", 1], ["acme-web", 3]]);

{
  const commits = chain(6), before = JSON.stringify(commits), segments = linearSegments(commits);
  assert.strictEqual(segments.length, 1);
  assert.deepStrictEqual(segments[0].hidden, [1, 2, 3, 4]);
  assert.strictEqual(segments[0].top, 0); assert.strictEqual(segments[0].bottom, 5);
  const folded = projectFolds(commits, segments, new Set([segments[0].id]));
  assert.strictEqual(folded.rows.length, 3); assert.strictEqual(folded.hiddenCount, 4);
  assert.strictEqual(folded.rows[1].segment, segments[0]);
  assert.deepStrictEqual(folded.rows[0].commit.parents, [folded.rows[1].commit.sha]);
  assert.deepStrictEqual(folded.rows[1].commit.parents, ["5"]);
  assert.strictEqual(folded.sourceToDisplay.get(5), 2);
  assert.strictEqual(folded.sourceToDisplay.get(1), undefined);
  const graph = layoutGraph(folded.rows.map((r) => r.commit), accents);
  assert.strictEqual(graph.columns, 1); assert.ok(graph.rows.every((r) => !r.missing));
  assert.deepStrictEqual(projectFolds(commits, segments, new Set()).rows.map((r) => r.commit), commits);
  assert.strictEqual(JSON.stringify(commits), before);
  console.log("ok - folding replaces only the linear interior, preserves endpoints and restores every original commit");
}
{
  const commits = chain(9); commits[4].refs = [{ kind: "tag", name: "v1" }];
  const segments = linearSegments(commits);
  assert.strictEqual(segments.length, 2);
  assert.deepStrictEqual(segments.map((s) => s.hidden), [[1, 2, 3], [5, 6, 7]]);
  const folded = projectFolds(commits, segments, new Set(segments.map((s) => s.id)));
  assert.ok(folded.rows.some((r) => r.commit.refs?.[0].name === "v1"));
  console.log("ok - labels, branch heads and tags split collapsible paths and remain visible");
}
{
  const commits = [c("merge", ["left", "right"]), c("left", ["l2"]), c("right", ["r2"]), c("l2", ["base"]), c("r2", ["r3"]), c("r3", ["r4"]), c("r4", ["base"]), c("base", [])];
  const segments = linearSegments(commits);
  assert.strictEqual(segments.length, 2);
  assert.notStrictEqual(segments[0].id, segments[1].id, "two paths with the same endpoints have distinct controls");
  assert.ok(segments.every((s) => s.top === 0 && s.bottom === 7));
  assert.strictEqual(segmentNodes(commits, segments).has(0), false, "a merge node is not an ambiguous fold button");
  const folded = projectFolds(commits, segments, new Set(segments.map((s) => s.id)));
  assert.strictEqual(folded.rows[0].commit.parents.length, 2);
  assert.ok(folded.sourceToDisplay.has(0) && folded.sourceToDisplay.has(7));
  assert.ok(layoutGraph(folded.rows.map((r) => r.commit), accents).rows.every((r) => !r.missing));
  console.log("ok - merging and forking endpoints survive independently folded paths, with real edges intact");
}
{
  const api = chain(5), web = chain(5, "acme-web");
  const commits = api.flatMap((a, i) => [a, web[i]]), segments = linearSegments(commits);
  assert.strictEqual(segments.length, 2);
  assert.deepStrictEqual(segments.map((s) => s.hidden), [[2, 4, 6], [3, 5, 7]]);
  const first = projectFolds(commits, segments, new Set([segments[0].id]));
  assert.deepStrictEqual(first.rows.filter((r) => r.commit.repoId === "acme-web").map((r) => commitKey(r.commit)), web.map(commitKey));
  const both = projectFolds(commits, segments, new Set(segments.map((s) => s.id)));
  const graph = layoutGraph(both.rows.map((r) => r.commit), accents);
  assert.strictEqual(graph.columns, 2);
  assert.ok(graph.rows.every((r) => !r.missing));
  console.log("ok - interleaved repositories with identical hashes fold independently without hiding or linking each other's commits");
}
{
  const filtered = chain(6).filter((_, i) => i !== 2);
  assert.deepStrictEqual(linearSegments(filtered), [], "a filtered-out parent breaks the path instead of connecting its surviving neighbors");
  assert.deepStrictEqual(linearSegments(chain(3)), [], "one hidden row saves no room");
  assert.deepStrictEqual(linearSegments([c("parent", []), c("child", ["parent"])]), [], "backwards history is never contracted");
  assert.deepStrictEqual(linearSegments([]), []);
  const first = chain(6).slice(0, 4), oldSegments = linearSegments(first);
  const expanded = chain(6), newSegments = linearSegments(expanded);
  const display = projectFolds(expanded, newSegments, new Set(oldSegments.map((s) => s.id)));
  assert.strictEqual(display.rows.length, 6, "appended history invalidates an incomplete old segment instead of hiding new rows silently");
  console.log("ok - filters, backwards clocks, short paths and newly loaded history cannot create false fold connections");
}
