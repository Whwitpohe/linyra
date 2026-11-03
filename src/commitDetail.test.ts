import * as assert from "assert";
import { diffSides, parseNumstat, parseShow, showArgs } from "./commitDetail";

const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);
const OTHER = "c".repeat(40);

{
  assert.deepStrictEqual(showArgs(SHA), ["show", "--raw", "--numstat", "-z", "-M", "--diff-merges=first-parent", "--format=%B%x1e", SHA]);
  console.log("ok - showArgs: full message then NUL-separated numstat, renames, first-parent for merges");
}

// Byte-exact shapes captured from git 2.43 (see plan Task 5 notes).
{
  const root = "-\t-\tbin.dat\x001\t0\tsp ace é.txt\x00";
  assert.deepStrictEqual(parseNumstat(root), [
    { path: "bin.dat", added: null, deleted: null },
    { path: "sp ace é.txt", added: 1, deleted: 0 },
  ]);
  console.log("ok - binary files have null counts; unicode and spaces are unquoted with -z");
}

{
  const rename = "0\t0\t\x00sp ace é.txt\x00renamed.txt\x00";
  assert.deepStrictEqual(parseNumstat(rename), [{ path: "renamed.txt", oldPath: "sp ace é.txt", added: 0, deleted: 0 }]);
  console.log("ok - a rename carries oldPath");
}

{
  const odd = "3\t1\tweird\tname\nx.txt\x00\n12\t40\tsrc/client.ts\x00";
  assert.deepStrictEqual(parseNumstat(odd), [
    { path: "weird\tname\nx.txt", added: 3, deleted: 1 },
    { path: "src/client.ts", added: 12, deleted: 40 },
  ]);
  console.log("ok - paths containing tabs or newlines survive; a stray leading newline is ignored");
}

{
  assert.deepStrictEqual(parseNumstat(""), []);
  assert.deepStrictEqual(parseNumstat("0\t0\t\x00only-old.txt\x00"), [], "a rename cut off before its new path is dropped");
  console.log("ok - empty and truncated output");
}

{
  const root = "/ws/acme-api";
  assert.deepStrictEqual(diffSides(root, { sha: SHA, parents: [PARENT] }, { path: "a.go" }), {
    before: { root, ref: PARENT, path: "a.go" },
    after: { root, ref: SHA, path: "a.go" },
  });
  assert.strictEqual(diffSides(root, { sha: SHA, parents: [] }, { path: "a.go" }).before.ref, null, "root commit: empty before side");
  assert.strictEqual(diffSides(root, { sha: SHA, parents: [PARENT] }, { path: "new.go", oldPath: "old.go" }).before.path, "old.go");
  assert.strictEqual(diffSides(root, { sha: SHA, parents: [PARENT, OTHER] }, { path: "a.go" }).before.ref, PARENT, "merge: first parent");
  // Added and deleted files: the empty side is known, so no git process is started for it.
  assert.strictEqual(diffSides(root, { sha: SHA, parents: [PARENT] }, { path: "new.go", status: "A" }).before.ref, null, "an added file has no before");
  assert.strictEqual(diffSides(root, { sha: SHA, parents: [PARENT] }, { path: "gone.go", status: "D" }).after.ref, null, "a deleted file has no after");
  assert.strictEqual(diffSides(root, { sha: SHA, parents: [PARENT] }, { path: "a.go", status: "M" }).after.ref, SHA);
  console.log("ok - diffSides: parent vs commit, empty root side, rename source, first parent of merges");
}

// Byte-exact shape from git 2.43: "<message>\n" RS NUL [NUL|\n] numstat…
{
  const out = "feat: sync code (ACME-7)\n\nfunc: ACME_SYNC_005\ntask: 7\n\x1e\x00\x001\t0\tside.txt\x00";
  assert.deepStrictEqual(parseShow(out), {
    message: "feat: sync code (ACME-7)\n\nfunc: ACME_SYNC_005\ntask: 7",
    files: [{ path: "side.txt", added: 1, deleted: 0 }],
  });
  assert.deepStrictEqual(parseShow("merge\n\x1e\x00\n1\t0\tside.txt\x00").files, [{ path: "side.txt", added: 1, deleted: 0 }]);
  assert.deepStrictEqual(parseShow("empty commit\n\x1e\x00"), { message: "empty commit", files: [] });
  assert.deepStrictEqual(parseShow("four\x1epart\n\nbody \x1e too\n\x1e\x00\n1\t0\todd\x1ename.txt\x00"), { message: "four\x1epart\n\nbody \x1e too", files: [{ path: "odd\x1ename.txt", added: 1, deleted: 0 }] }, "an RS in the message or a path is text");
  assert.deepStrictEqual(parseShow(":100644 100644 aaaaaaa bbbbbbb M\x00odd\x1ename.txt\x001\t0\todd\x1ename.txt\x00"), { message: "", files: [{ path: "odd\x1ename.txt", added: 1, deleted: 0, status: "M" }] }, "git diff --raw --numstat has no message");
  console.log("ok - parseShow splits the full message from the file list");
}

// Byte shape from git 2.43 with --raw: raw records (":<modes> <shas> <STATUS>\0path\0",
// renames carry old and new), then the numstat records.
{
  const raw = (st: string, ...paths: string[]) => `:100644 100644 ${"a".repeat(7)} ${"b".repeat(7)} ${st}\x00${paths.join("\x00")}\x00`;
  const out = "mix\n\x1e\x00" +
    raw("D", "gone.txt") + raw("R100", "renamed.txt", "moved.txt") + raw("A", "new.txt") + raw("M", "side.txt") +
    "0\t1\tgone.txt\x000\t0\t\x00renamed.txt\x00moved.txt\x001\t0\tnew.txt\x001\t0\tside.txt\x00";
  assert.deepStrictEqual(parseShow(out).files, [
    { path: "gone.txt", added: 0, deleted: 1, status: "D" },
    { path: "moved.txt", oldPath: "renamed.txt", added: 0, deleted: 0, status: "R" },
    { path: "new.txt", added: 1, deleted: 0, status: "A" },
    { path: "side.txt", added: 1, deleted: 0, status: "M" },
  ]);
  console.log("ok - parseShow attaches each file's change status from --raw");
}
