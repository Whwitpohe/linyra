import * as assert from "assert";
import { parseReferences, readReferences, referenceArgs, referenceLabels } from "./commitReferences";
import type { RunGit } from "./logQuery";

const sha = "a".repeat(40);
const next = "b".repeat(40);
const row = (ref: string, object = sha, peeled = "", symbolic = "", current = " ") => [ref, object, peeled, symbolic, current].join("\0");
const output = [
  row("refs/heads/develop"), row("refs/heads/fix/preview", sha, "", "", "*"),
  row("refs/heads/release", next), row("refs/remotes/origin/develop"),
  row("refs/remotes/origin/HEAD", sha, "", "refs/remotes/origin/develop"),
  row("refs/tags/v1.0", next, sha), row("refs/tags/v2.0", next),
].join("\n");
{
  const refs = parseReferences(output, sha, sha, true);
  assert.deepStrictEqual(refs.refs, [
    { kind: "head", name: "HEAD" }, { kind: "local", name: "develop" },
    { kind: "local", name: "fix/preview" }, { kind: "remote", name: "origin/develop" }, { kind: "tag", name: "v1.0" },
  ]);
  assert.deepStrictEqual(refs.containingBranches, ["HEAD", "fix/preview", "develop", "release", "origin/develop"]);
  assert.ok(!parseReferences(output, sha, next, true).refs.some((r) => r.kind === "head"), "containing is distinct from pointing at the commit");
  assert.deepStrictEqual(parseReferences("", sha, next, false), { refs: [], containingBranches: [] });
  assert.ok(referenceArgs(sha).includes(`--contains=${sha}`));
  console.log("ok - actual commit refs distinguish HEAD, local/remote branches, annotated tags and containing branches");
}

{
  const labels = referenceLabels([{ kind: "head", name: "HEAD" }, { kind: "local", name: "feature/preview" },
    { kind: "remote", name: "origin/feature/preview" }, { kind: "remote", name: "upstream/main" }, { kind: "tag", name: "v1" }]);
  assert.deepStrictEqual(labels.map((ref) => ref.label), ["origin & feature/preview", "upstream/main", "v1"]);
  assert.deepStrictEqual(labels[0].kinds, ["remote", "local"]);
  assert.strictEqual(referenceLabels([{ kind: "head", name: "HEAD" }])[0].label, "HEAD", "detached HEAD keeps its label");
  console.log("ok - matching local and remote branch tips share compact labels and keep distinct icon kinds");
}

async function main(): Promise<void> {
  const calls: string[][] = [];
  const run: RunGit = async (_root, args) => {
    calls.push(args);
    if (args[0] === "for-each-ref") return output;
    if (args[0] === "rev-parse") return sha + "\n";
    throw new Error("an ancestry query is unnecessary for HEAD");
  };
  assert.strictEqual((await readReferences(run, "/ws/acme-web", sha, new AbortController().signal)).refs[0].kind, "head");
  assert.strictEqual(calls.length, 2);
  const detached: RunGit = async (_root, args) => args[0] === "for-each-ref" ? "" : args[0] === "rev-parse" ? next : "";
  assert.deepStrictEqual((await readReferences(detached, "/ws/acme-web", sha, new AbortController().signal)).containingBranches, ["HEAD"]);
  console.log("ok - reference reads use argv and also handle an ancestor of detached HEAD");
}
void main().catch((e) => { console.error(e); process.exitCode = 1; });
