import * as assert from "assert";
import { combineRepo, mergeBaseArgs, parseRangeLog, rangeLogArgs, type RangeCommit, type RawChange } from "./combinedModel";

const Z = "0".repeat(40);
const blob = (n: number) => String(n).padStart(40, "b");
const ch = (status: RawChange["status"], path: string, oldBlob: string, newBlob: string, oldPath?: string): RawChange =>
  oldPath ? { status, path, oldPath, oldBlob, newBlob } : { status, path, oldBlob, newBlob };
const byPath = <T extends { path: string }>(files: T[]): Record<string, T> => Object.fromEntries(files.map((f) => [f.path, f]));

{
  assert.deepStrictEqual(mergeBaseArgs(["c", "a"]), ["merge-base", "--octopus", "c", "a"]);
  assert.deepStrictEqual(rangeLogArgs(["c", "a"], ["p"]), ["log", "--topo-order", "--raw", "-z", "-M", "--no-abbrev", "--diff-merges=first-parent", "--format=%x1e%H %P%x1f%s", "c", "a", "--not", "p"]);
  assert.deepStrictEqual(rangeLogArgs(["c"], []), ["log", "--topo-order", "--raw", "-z", "-M", "--no-abbrev", "--diff-merges=first-parent", "--format=%x1e%H %P%x1f%s", "c"]);
  console.log("ok - range log args; a root commit has no --not");
}

{
  const C = "c".repeat(40);
  const M = "d".repeat(40);
  const P1 = "e".repeat(40);
  const P2 = "f".repeat(40);
  const out =
    `\x1e${M} ${P1} ${P2}\x1fMerge branch 'fix'\0\n:100644 100644 ${blob(1)} ${blob(2)} M\0src/a.ts\0` +
    `\x1e${C} ${P1}\0\n:100644 100644 ${blob(3)} ${blob(3)} R100\0old name.ts\0new name.ts\0:000000 100644 ${Z} ${blob(4)} A\0b.ts\0` +
    `\x1e${P1}\0\n`;
  assert.deepStrictEqual(parseRangeLog(out), [
    { sha: M, parents: [P1, P2], subject: "Merge branch 'fix'", changes: [ch("M", "src/a.ts", blob(1), blob(2))] },
    { sha: C, parents: [P1], changes: [ch("R", "new name.ts", blob(3), blob(3), "old name.ts"), ch("A", "b.ts", Z, blob(4))] },
    { sha: P1, parents: [], changes: [] },
  ]);
  console.log("ok - parseRangeLog: merges, renames with spaces, root commits");
}

// The spec's example: a (dana), x (rin), c (dana) in acme-web; a and c selected.
const example: RangeCommit[] = [
  { sha: "c", parents: ["x"], changes: [ch("M", "src/header.ts", blob(3), blob(4)), ch("M", "src/header.css", blob(13), blob(14)), ch("D", "src/debug.ts", blob(21), Z)] },
  { sha: "x", parents: ["a"], changes: [ch("M", "src/header.ts", blob(2), blob(3)), ch("M", "src/header.css", blob(12), blob(13))] },
  { sha: "a", parents: ["p"], changes: [ch("M", "src/header.ts", blob(1), blob(2)), ch("M", "src/header.css", blob(11), blob(12)), ch("A", "src/debug.ts", Z, blob(21)), ch("M", "src/only-a.ts", blob(31), blob(32))] },
];
{
  const { files, noNetChange } = combineRepo(new Set(["a", "c"]), example);
  const f = byPath(files);
  assert.deepStrictEqual(Object.keys(f).sort(), ["src/header.css", "src/header.ts", "src/only-a.ts"]);
  assert.deepStrictEqual(f["src/header.ts"], { path: "src/header.ts", status: "M", shas: ["a", "c"], last: "c", beforeRef: "p", beforePath: "src/header.ts", included: ["x"], fast: false });
  assert.deepStrictEqual(f["src/header.css"].included, ["x"]);
  assert.deepStrictEqual(f["src/only-a.ts"], { path: "src/only-a.ts", status: "M", shas: ["a"], last: "a", beforeRef: "p", beforePath: "src/only-a.ts", included: [], fast: true });
  assert.deepStrictEqual(noNetChange, ["src/debug.ts"]);
  console.log("ok - combineRepo: each file once, unselected commits in between, added-then-deleted left out");
}

{
  // An unselected commit after the last selected one that touched the file does not count.
  const { files } = combineRepo(new Set(["a", "x"]), example);
  assert.deepStrictEqual(byPath(files)["src/header.ts"].included, []);
  assert.strictEqual(byPath(files)["src/header.ts"].fast, true);
  console.log("ok - combineRepo: later unselected commits are outside the file's range");
}

{
  const linear = (changes: RawChange[][]): RangeCommit[] =>
    changes.map((c, i) => ({ sha: `s${i}`, parents: i === changes.length - 1 ? ["p"] : [`s${i + 1}`], changes: c }));
  const all = (n: number) => new Set(Array.from({ length: n }, (_, i) => `s${i}`));
  const status = (log: RangeCommit[]) => combineRepo(all(log.length), log).files.map((f) => f.status);
  // Newest first, as git prints them.
  assert.deepStrictEqual(status(linear([[ch("M", "f", blob(2), blob(3))], [ch("A", "f", Z, blob(2))]])), ["A"]);
  assert.deepStrictEqual(status(linear([[ch("D", "f", blob(2), Z)], [ch("M", "f", blob(1), blob(2))]])), ["D"]);
  assert.deepStrictEqual(status(linear([[ch("A", "f", Z, blob(5))], [ch("D", "f", blob(1), Z)]])), ["M"]);
  assert.deepStrictEqual(status(linear([[ch("M", "f", blob(2), blob(3))], [ch("M", "f", blob(1), blob(2))]])), ["M"]);
  const back = linear([[ch("M", "f", blob(2), blob(1))], [ch("M", "f", blob(1), blob(2))]]);
  assert.deepStrictEqual(combineRepo(all(2), back), { files: [], noNetChange: ["f"] });
  console.log("ok - net status table, and changes that cancel out are left out");
}

{
  const log: RangeCommit[] = [
    { sha: "c", parents: ["b"], changes: [ch("M", "new.ts", blob(2), blob(3))] },
    { sha: "b", parents: ["a"], changes: [ch("R", "new.ts", blob(2), blob(2), "old.ts")] },
    { sha: "a", parents: ["p"], changes: [ch("M", "old.ts", blob(1), blob(2))] },
  ];
  const { files } = combineRepo(new Set(["a", "b", "c"]), log);
  assert.deepStrictEqual(files, [{ path: "new.ts", oldPath: "old.ts", status: "R", shas: ["a", "b", "c"], last: "c", beforeRef: "p", beforePath: "old.ts", included: [], fast: true }]);
  // Renamed by an unselected commit: still one file, and it takes the slow path.
  const { files: f2 } = combineRepo(new Set(["a", "c"]), log);
  assert.deepStrictEqual(f2.map((f) => [f.path, f.beforePath, f.included, f.fast]), [["new.ts", "old.ts", ["b"], false]]);
  console.log("ok - renames are followed by path");
}

{
  // An unselected merge brings a teammate's edit into header.ts between a and c.
  const log: RangeCommit[] = [
    { sha: "c", parents: ["m"], changes: [ch("M", "header.ts", blob(3), blob(4))] },
    { sha: "m", parents: ["a", "t"], changes: [ch("M", "header.ts", blob(2), blob(3))] },
    { sha: "t", parents: ["p"], changes: [ch("M", "header.ts", blob(1), blob(9))] },
    { sha: "a", parents: ["p"], changes: [ch("M", "header.ts", blob(1), blob(2))] },
  ];
  const [f] = combineRepo(new Set(["a", "c"]), log).files;
  assert.deepStrictEqual([f.included, f.fast], [["t", "m"], false]);
  console.log("ok - an unselected merge in range sends the file to the slow path");
}

{
  // a and c on two branches: c is not a descendant of a.
  const log: RangeCommit[] = [
    { sha: "c", parents: ["q"], changes: [ch("M", "f.ts", blob(1), blob(3))] },
    { sha: "a", parents: ["p"], changes: [ch("M", "f.ts", blob(1), blob(2))] },
  ];
  const [f] = combineRepo(new Set(["a", "c"]), log).files;
  assert.deepStrictEqual([f.included, f.fast], [[], false]);
  console.log("ok - selected commits on two branches take the slow path");
}
