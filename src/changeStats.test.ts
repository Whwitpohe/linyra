import assert from "node:assert/strict";
import { isChangesMode, parseStats, statsArgs, statsRequests } from "./changeStats";
import { abbreviated, arcPath, bar, bipolar, capped, magnitude, ringSweep, squares } from "./webview/changeViz";

const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40), d = "d".repeat(40);
const out = `\x1e${a}\n\n 3 files changed, 12 insertions(+), 4 deletions(-)\n\x1e${b}\n\n 1 file changed, 1 insertion(+)\n\x1e${c}\n\x1e${d}\n\n 2 files changed, 7 deletions(-)\n`;
assert.deepEqual([...parseStats(out)], [
  [a, { files: 3, added: 12, deleted: 4 }],
  [b, { files: 1, added: 1, deleted: 0 }],
  [c, { files: 0, added: 0, deleted: 0 }],
  [d, { files: 2, added: 0, deleted: 7 }],
]);
assert.ok(statsArgs().includes("--stdin") && statsArgs().includes("--no-walk=unsorted") && statsArgs().includes("--shortstat"));
console.log("ok - shortstat: files, insertions, deletions (each part optional); an empty commit has zeros");

const known = (id: string) => id === "/w/acme-web" || id === "/w/acme-api";
const req = statsRequests([{ repoId: "/w/acme-web", sha: a }, { repoId: "/w/acme-web", sha: a }, { repoId: "/w/acme-api", sha: b }, { repoId: "/w/other", sha: c }, { repoId: "/w/acme-web", sha: "nope" }, null], known);
assert.deepEqual([...req], [["/w/acme-web", [a]], ["/w/acme-api", [b]]]);
assert.equal([...statsRequests(Array.from({ length: 10 }, (_, i) => ({ repoId: "/w/acme-web", sha: i.toString(16).repeat(40) })), known, 4).values()][0].length, 4);
assert.ok(isChangesMode("bar") && !isChangesMode("pie"));
console.log("ok - stats requests: known repositories, valid ids, each once, at most the cap");

assert.deepEqual(squares({ added: 0, deleted: 0 }), { added: 0, deleted: 0 });
assert.deepEqual(squares({ added: 10, deleted: 0 }), { added: 5, deleted: 0 });
assert.deepEqual(squares({ added: 30, deleted: 10 }), { added: 4, deleted: 1 });
assert.deepEqual(squares({ added: 1, deleted: 99 }), { added: 1, deleted: 4 }, "a side with any line shows");
assert.deepEqual(squares({ added: 99, deleted: 1 }), { added: 4, deleted: 1 });
console.log("ok - squares: five, by ratio; each non-empty side gets one at least");

assert.equal(magnitude(1600), 1);
assert.equal(magnitude(400), 0.5);
assert.equal(magnitude(10_000), 1, "saturates");
assert.deepEqual(bar({ added: 300, deleted: 100 }), { fill: 0.5, addedShare: 0.75 });
assert.deepEqual(bar({ added: 0, deleted: 0 }), { fill: 0, addedShare: 0 });
assert.deepEqual(bipolar({ added: 1600, deleted: 100 }), { left: 0.25, right: 1 });
assert.deepEqual(ringSweep({ added: 300, deleted: 100 }), { added: 135, deleted: 45 });
assert.equal(arcPath(8, 6, 0, 0), "");
assert.match(arcPath(8, 6, 0, 270), /^M 8.00 2.00 A 6 6 0 1 1 /);
console.log("ok - bar, bipolar and ring: an absolute √ scale that saturates at 1600 lines");

assert.equal(capped(999), "999");
assert.equal(capped(1000), "999+");
assert.equal(abbreviated(950), "950");
assert.equal(abbreviated(1800), "1.8k");
assert.equal(abbreviated(2000), "2k");
assert.equal(abbreviated(12_345), "12k");
console.log("ok - counts: 999+ for files, 1.8k / 12k for lines in the compact column");
