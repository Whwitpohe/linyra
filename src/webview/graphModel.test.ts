import * as assert from "assert";
import { commitKey, type Commit } from "../types";
import { layoutGraph } from "./graphModel";

const commit = (repoId: string, sha: string, parents: string[] = []): Commit => ({ repoId, sha, parents, time: 0, author: "dana", email: "dana@example.com", subject: sha });
const accents = new Map([["acme-api", 1], ["acme-web", 3]]);

{
  const graph = layoutGraph([commit("acme-api", "a", ["b"]), commit("acme-api", "b", ["c"]), commit("acme-api", "c")], accents);
  assert.strictEqual(graph.columns, 1);
  assert.deepStrictEqual(graph.rows.map((r) => r.node.column), [0, 0, 0]);
  assert.deepStrictEqual(graph.rows.map((r) => r.incoming), [false, true, true]);
  assert.ok(graph.rows.every((r) => r.through.length === 0 && r.missing === undefined));
  console.log("ok - a linear history stays in one lane and ends at its root");
}
{
  const commits = [commit("acme-api", "same", ["base"]), commit("acme-web", "same", ["base"]), commit("acme-api", "base"), commit("acme-web", "base")];
  const graph = layoutGraph(commits, accents);
  assert.strictEqual(graph.columns, 2);
  assert.deepStrictEqual(graph.rows.map((r) => r.node.column), [0, 1, 0, 1]);
  assert.deepStrictEqual(graph.rows.map((r) => r.node.accent), [1, 3, 1, 3]);
  assert.deepStrictEqual(graph.rows[1].through.map((r) => r.column), [0]);
  assert.deepStrictEqual(graph.rows[2].through.map((r) => r.column), [1]);
  console.log("ok - interleaved repositories and identical hashes never share a parent lane");
}
{
  const graph = layoutGraph([commit("acme-api", "merge", ["left", "right"]), commit("acme-api", "left", ["base"]), commit("acme-api", "right", ["base"]), commit("acme-api", "base")], accents);
  assert.strictEqual(graph.columns, 2);
  assert.deepStrictEqual(graph.rows[0].outgoing.map((r) => r.column), [0, 1]);
  assert.deepStrictEqual(graph.rows[2].through.map((r) => r.column), [0]);
  assert.strictEqual(graph.rows[2].outgoing[0].column, graph.rows[3].node.column);
  assert.strictEqual(graph.rows[3].incoming, true);
  assert.notStrictEqual(graph.rows[0].outgoing[0].accent, graph.rows[0].outgoing[1].accent, "parallel branches within one repository have distinct colors");
  console.log("ok - a merge splits into its two parents and rejoins at their shared ancestor");
}

{
  const rows = [commit("acme-api", "tip-a", ["base"]), commit("acme-web", "tip-b", ["web-base"]),
    commit("acme-api", "tip-c", ["base"]), commit("acme-api", "base"), commit("acme-web", "web-base")];
  const graph = layoutGraph(rows, accents);
  assert.notStrictEqual(graph.rows[0].node.column, graph.rows[2].node.column, "unmerged tips occupy separate rails");
  assert.notStrictEqual(graph.rows[0].node.accent, graph.rows[2].node.accent, "unmerged tips have separate colors");
  assert.strictEqual(graph.rows[0].outgoing[0].column, graph.rows[2].outgoing[0].column, "the true shared ancestor is joined");
  assert.strictEqual(graph.rows[4].node.column, graph.rows[1].outgoing[0].column, "interleaved repositories retain their own rails");
  console.log("ok - unmerged multi-branch tips split into distinct colored rails and rejoin only at their shared ancestor");
}
{
  const first = commit("acme-api", "tip", ["older"]);
  assert.ok(layoutGraph([first], accents).rows[0].missing);
  const appended = layoutGraph([first, commit("acme-api", "older")], accents);
  assert.strictEqual(appended.rows[0].missing, undefined);
  assert.strictEqual(appended.rows[1].incoming, true);
  const filtered = layoutGraph([first, commit("acme-api", "unrelated")], accents);
  assert.ok(filtered.rows[0].missing);
  assert.strictEqual(filtered.rows[1].incoming, false);
  console.log("ok - paging resolves dashed parent endpoints; filters never invent connections");
}
{
  const commits = [commit("acme-api", "parent"), commit("acme-api", "child", ["parent"])];
  const before = commits.map(commitKey);
  const graph = layoutGraph(commits, accents);
  assert.strictEqual(graph.rows[0].outgoing.length, 1);
  assert.strictEqual(graph.rows[1].incoming, true);
  assert.deepStrictEqual(commits.map(commitKey), before);
  console.log("ok - a backwards clock still connects the real parent without reordering the log");
}
{
  const graph = layoutGraph([commit("acme-api", "merge", ["a", "b", "c"]), ...["a", "b", "c"].map((id) => commit("acme-api", id))], accents);
  assert.strictEqual(graph.columns, 3);
  assert.deepStrictEqual(graph.rows[0].outgoing.map((r) => r.column), [0, 1, 2]);
  assert.ok(graph.rows.slice(1).every((r) => r.incoming));
  assert.deepStrictEqual(layoutGraph([], accents), { rows: [], columns: 0 });
  console.log("ok - octopus merges and an empty log have bounded, valid lanes");
}
