import * as assert from "assert";
import { parseDecorations, parseReferences, readReferences, referenceArgs, refGroups, refPillContext, withUpstream, type CommitReference } from "./commitReferences";
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
    { kind: "local", name: "fix/preview", current: true }, { kind: "remote", name: "origin/develop" }, { kind: "tag", name: "v1.0" },
  ]);
  assert.deepStrictEqual(refs.containingBranches, ["HEAD", "fix/preview", "develop", "release", "origin/develop"]);
  assert.ok(!parseReferences(output, sha, next, true).refs.some((r) => r.kind === "head"), "containing is distinct from pointing at the commit");
  assert.deepStrictEqual(parseReferences("", sha, next, false), { refs: [], containingBranches: [] });
  assert.ok(referenceArgs(sha).includes(`--contains=${sha}`));
  console.log("ok - actual commit refs distinguish HEAD, local/remote branches, annotated tags and containing branches");
}

{
  assert.deepStrictEqual(parseDecorations("HEAD -> refs/heads/develop, refs/remotes/origin/develop, tag: refs/tags/v1"), [
    { kind: "head", name: "HEAD" }, { kind: "local", name: "develop", current: true }, { kind: "remote", name: "origin/develop" }, { kind: "tag", name: "v1" },
  ]);
  // Detached at a commit a branch points to: git writes "HEAD" alone, and the branch is not checked out.
  assert.deepStrictEqual(parseDecorations("HEAD, tag: refs/tags/v2, refs/remotes/origin/HEAD, refs/heads/main"), [
    { kind: "head", name: "HEAD" }, { kind: "tag", name: "v2" }, { kind: "remote", name: "origin/HEAD" }, { kind: "local", name: "main" },
  ]);
  console.log("ok - decorations mark the checked-out branch, and a bare HEAD stays detached");
}

{
  const labels = (pills: { label: string }[][]) => pills.map((p) => p.map((s) => s.label).join(" | "));
  const refs = parseDecorations("HEAD -> refs/heads/feature/preview, refs/remotes/origin/feature/preview, refs/remotes/upstream/main, refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/release-1.4, tag: refs/tags/v1, refs/remotes/origin/HEAD");
  const pills = refGroups(refs);
  assert.deepStrictEqual(labels(pills), ["feature/preview | origin", "main | upstream | origin", "origin/release-1.4", "v1"],
    "current first, same-name remotes joined, a remote with no local branch apart, origin/HEAD dropped, HEAD not a pill");
  assert.deepStrictEqual(pills[0].map((s) => [s.kind, s.ref, s.current === true]), [["local", "refs/heads/feature/preview", true], ["remote", "refs/remotes/origin/feature/preview", false]]);
  assert.strictEqual(pills[0][1].title, "origin/feature/preview", "a joined remote keeps its whole name in the title");
  assert.deepStrictEqual(pills.map((p) => p[0].kind), ["local", "local", "remote", "tag"]);
  assert.strictEqual(pills[2][0].ref, "refs/remotes/origin/release-1.4");
  // origin/feature/x is not x's remote: endsWith alone would have joined them.
  assert.deepStrictEqual(labels(refGroups([{ kind: "local", name: "x" }, { kind: "remote", name: "origin/feature/x" }])), ["x", "origin/feature/x"]);
  // A remote branch is joined to one local branch, never two.
  assert.deepStrictEqual(labels(refGroups([{ kind: "local", name: "a" }, { kind: "local", name: "a" }, { kind: "remote", name: "origin/a" }])), ["a | origin", "a"]);
  console.log("ok - refGroups joins a local branch and its same-name remotes into one pill, tags apart");
}

{
  const detached: CommitReference[] = [{ kind: "head", name: "HEAD" }, { kind: "local", name: "main" }, { kind: "tag", name: "v2" }];
  const pills = refGroups(detached);
  assert.deepStrictEqual(pills.map((p) => p.map((s) => `${s.kind}:${s.label}`)), [["detached:HEAD"], ["local:main"], ["tag:v2"]]);
  assert.strictEqual(pills[1][0].current, undefined, "a branch at a detached HEAD is not current");
  assert.deepStrictEqual(refGroups([{ kind: "head", name: "HEAD" }]).map((p) => p[0].kind), ["detached"], "detached HEAD alone keeps its pill");
  // The caller can say which branch is checked out (or that none is).
  assert.strictEqual(refGroups(detached, "main")[0][0].current, true);
  assert.strictEqual(refGroups(detached, "main").length, 2);
  assert.strictEqual(refGroups(parseDecorations("HEAD -> refs/heads/main"), null)[0][0].kind, "detached");
  assert.deepStrictEqual(refGroups([]), []);
  console.log("ok - HEAD is a pill only when detached");
}

{
  const [current, other] = refGroups(parseDecorations("HEAD -> refs/heads/develop, refs/remotes/origin/develop, refs/heads/main"));
  assert.deepStrictEqual(withUpstream(current, { ahead: 1, behind: 2 }).map((s) => [s.ahead, s.behind]), [[1, 2], [undefined, undefined]]);
  assert.deepStrictEqual(withUpstream(other, { ahead: 1, behind: 2 }), other, "only the checked-out branch carries the upstream state");
  assert.deepStrictEqual(withUpstream(current, undefined), current);
  assert.deepStrictEqual(refPillContext("/ws/acme-web", current), { webviewSection: "refPill", repoId: "/ws/acme-web", ref: "refs/heads/develop", kind: "local", current: true });
  assert.deepStrictEqual(refPillContext("/ws/acme-web", refGroups([{ kind: "tag", name: "v1" }])[0]), { webviewSection: "refPill", repoId: "/ws/acme-web", ref: "refs/tags/v1", kind: "tag", current: false });
  assert.strictEqual(refPillContext("/ws/acme-web", refGroups([{ kind: "head", name: "HEAD" }])[0]), undefined, "a detached HEAD has no branch menu");
  console.log("ok - the current pill carries its upstream state; a pill's menu context names the full ref");
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
