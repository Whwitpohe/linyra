import assert from "node:assert/strict";
import { kindCounts, lineTotals, sumKinds, totalFiles } from "./changeKinds";

const c = kindCounts([
  { path: "a.ts", added: 1, deleted: 0, status: "M" },
  { path: "a.ts", added: 2, deleted: 1, status: "M" },
  { path: "new.ts", added: 3, deleted: 0, untracked: true },
  { path: "gone.ts", added: 0, deleted: 4, status: "D" },
  { path: "moved.ts", oldPath: "old.ts", added: 0, deleted: 0, status: "R" },
  { path: "copy.ts", added: 5, deleted: 0, status: "C" },
]);
assert.deepEqual(c, { added: 2, modified: 1, deleted: 1, renamed: 1 });
assert.equal(totalFiles(c), 5);
console.log("ok - kindCounts: distinct files by kind, a copy counts as new");

assert.deepEqual(kindCounts([{ path: "x", added: 1, deleted: 0, status: "M" }, { path: "x", added: 1, deleted: 0, status: "A" }]), { added: 1, modified: 0, deleted: 0, renamed: 0 },
  "a file staged as new and changed again is new");
console.log("ok - kindCounts: a path listed twice takes its stronger kind");

assert.deepEqual(sumKinds([{ added: 1, modified: 2, deleted: 0, renamed: 0 }, { added: 0, modified: 1, deleted: 3, renamed: 1 }]), { added: 1, modified: 3, deleted: 3, renamed: 1 });
assert.deepEqual(lineTotals([{ path: "a", added: 2, deleted: 1 }, { path: "bin", added: null, deleted: null }]), { added: 2, deleted: 1 });
console.log("ok - sumKinds and lineTotals add up; binary files add no lines");
