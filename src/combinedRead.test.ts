import * as assert from "assert";
import { leftSide, showArgs } from "./combinedRead";
import type { RunGit } from "./logQuery";

const Z = "0".repeat(40);
const A = "a".repeat(40);
const X = "e".repeat(40);
const C = "c".repeat(40);
const P = "f".repeat(40);
const blob = (n: number) => String(n).padStart(40, "b");

/** A fake git: `git show <sha>` records and blob contents, nothing else. */
function fakeGit(commits: Record<string, string>, blobs: Record<string, string>): RunGit {
  return async (_cwd: string, args: string[]) => {
    const target = args[args.length - 1];
    if (args[0] === "show" && args.includes("--raw")) {
      if (!(target in commits)) throw new Error(`bad commit ${target}`);
      return commits[target];
    }
    if (args[0] === "diff") return commits[`diff ${args[args.length - 2]} ${target}`] ?? "";
    if (args[0] === "cat-file" && target in blobs) return blobs[target];
    if (args[0] === "show" && target.includes(":") && target in blobs) return blobs[target];
    throw new Error(`fatal: no such object ${target}`);
  };
}
const rec = (sha: string, parent: string, ...raw: string[]) => `\x1e${sha} ${parent}\0\n${raw.join("")}`;
const m = (path: string, from: string, to: string) => `:100644 100644 ${from} ${to} M\0${path}\0`;
const signal = new AbortController().signal;

const v1 = "import\nconst h = el(\"title\");\nh.text = title;\nh.pad = 8;\nreturn h;\n";
const va = "import\nconst h = el(\"title\");\nh.text = clip(title);\nh.pad = 8;\nreturn h;\n"; // a: line 3
const vx = "import { el }\nconst h = el(\"title\");\nh.text = clip(title);\nh.pad = 8;\nreturn h;\n"; // x (rin): line 1, one line clear of a's
const vc = "import { el }\nconst h = el(\"title\");\nh.text = clip(title);\nh.pad = 8;\nreturn h; // done\n"; // c: line 5
const commits = {
  [A]: rec(A, P, m("header.ts", blob(1), blob(2))),
  [X]: rec(X, A, m("header.ts", blob(2), blob(3))),
  [C]: rec(C, X, m("header.ts", blob(3), blob(4))),
};
const blobs = { [blob(1)]: v1, [blob(2)]: va, [blob(3)]: vx, [blob(4)]: vc, [`${C}:header.ts`]: vc };

(async () => {
{
  assert.deepStrictEqual(showArgs(C), ["show", "--raw", "-z", "-M", "--no-abbrev", "--diff-merges=first-parent", "--format=%x1e%H %P%x1f%s", C]);
  console.log("ok - each taken-out commit is read with one git show");
}
{
  const left = await leftSide(fakeGit(commits, blobs), "/ws", C, "header.ts", [C, A], signal);
  assert.deepStrictEqual(left, { kind: "text", text: "import { el }\nconst h = el(\"title\");\nh.text = title;\nh.pad = 8;\nreturn h;\n" });
  console.log("ok - a and c are taken out; rin's line 1 stays");
}
{
  // x edited the same line as a: they can't be shown apart.
  const vx2 = "import\nconst h = el(\"title\");\nh.text = clip(title, 80);\nh.pad = 8;\nreturn h;\n";
  const vc2 = vx2.replace("return h;", "return h; // done");
  const git = fakeGit(commits, { ...blobs, [blob(3)]: vx2, [blob(4)]: vc2, [`${C}:header.ts`]: vc2 });
  assert.deepStrictEqual(await leftSide(git, "/ws", C, "header.ts", [C, A], signal), { kind: "fallback", reason: "conflict" });
  console.log("ok - an overlapping unselected edit falls back");
}
{
  const bin = "PNG\0\x01";
  const git = fakeGit({ [C]: rec(C, X, m("logo.png", blob(5), blob(6))) }, { [blob(5)]: bin, [blob(6)]: bin + "x", [`${C}:logo.png`]: bin + "x" });
  assert.deepStrictEqual(await leftSide(git, "/ws", C, "logo.png", [C], signal), { kind: "fallback", reason: "binary" });
  const big = "x\n".repeat(20_001);
  const git2 = fakeGit({ [C]: rec(C, X, m("big.txt", blob(7), blob(8))) }, { [blob(7)]: big, [blob(8)]: big + "y\n", [`${C}:big.txt`]: big + "y\n" });
  assert.deepStrictEqual(await leftSide(git2, "/ws", C, "big.txt", [C], signal), { kind: "fallback", reason: "too large" });
  console.log("ok - binary and too large files fall back");
}
{
  // a edits old.ts, b (unselected) renames it, c edits new.ts: a's step reads the old path's blobs.
  const B = "d".repeat(40);
  const git = fakeGit({
    [C]: rec(C, B, m("new.ts", blob(2), blob(3))),
    [A]: rec(A, P, m("old.ts", blob(1), blob(9))),
    [`diff ${A} ${B}`]: `:100644 100644 ${blob(9)} ${blob(2)} R090\0old.ts\0new.ts\0`,
  }, { [blob(1)]: "1\n2\n3\n", [blob(9)]: "1\nTWO\n3\n", [blob(2)]: "1\nTWO\n3\n4\n", [blob(3)]: "1\nTWO\n3\n4\nFIVE\n", [`${C}:new.ts`]: "1\nTWO\n3\n4\nFIVE\n" });
  assert.deepStrictEqual(await leftSide(git, "/ws", C, "new.ts", [C, A], signal), { kind: "text", text: "1\n2\n3\n4\n" });
  console.log("ok - a rename by an unselected commit is followed back to the old path");
}
{
  // After following the rename back, older selected commits are read at the old path too.
  const B = "d".repeat(40);
  const Q = "9".repeat(40);
  const git = fakeGit({
    [C]: rec(C, B, m("new.ts", blob(2), blob(3))),
    [A]: rec(A, Q, m("old.ts", blob(10), blob(9))),
    [Q]: rec(Q, P, m("old.ts", blob(1), blob(10))),
    [`diff ${A} ${B}`]: `:100644 100644 ${blob(9)} ${blob(2)} R090\0old.ts\0new.ts\0`,
  }, { [blob(1)]: "1\n2\n3\n", [blob(10)]: "ONE\n2\n3\n", [blob(9)]: "ONE\nTWO\n3\n", [blob(2)]: "ONE\nTWO\n3\n4\n", [blob(3)]: "ONE\nTWO\n3\n4\nFIVE\n", [`${C}:new.ts`]: "ONE\nTWO\n3\n4\nFIVE\n" });
  assert.deepStrictEqual(await leftSide(git, "/ws", C, "new.ts", [C, A, Q], signal), { kind: "text", text: "1\n2\n3\n4\n" });
  console.log("ok - commits older than the rename are read at the old path");
}
{
  // Added by the oldest step: its "before" is empty.
  const git = fakeGit({
    [C]: rec(C, A, m("new.ts", blob(1), blob(2))),
    [A]: rec(A, P, `:000000 100644 ${Z} ${blob(1)} A\0new.ts\0`),
  }, { [blob(1)]: "a\n", [blob(2)]: "a\nb\n", [`${C}:new.ts`]: "a\nb\n" });
  assert.deepStrictEqual(await leftSide(git, "/ws", C, "new.ts", [C, A], signal), { kind: "text", text: "" });
  console.log("ok - a file added by the selection has an empty left side");
}
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
