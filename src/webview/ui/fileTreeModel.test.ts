import * as assert from "assert";
import { filterTree, findByPrefix, flattenTree, keepShown, navigate, pick, rowWindow, scrollToShow, treeKey, type FilterOptions } from "./fileTreeModel";

interface Node { id: string; label: string; kind: "folder" | "file" | "commit" | "more"; path?: string; oldPath?: string; description?: string; children?: Node[] }
const file = (path: string, extra: Partial<Node> = {}): Node => ({ id: `f:${path}`, label: path.split("/").pop()!, kind: "file", path, ...extra });
const folder = (path: string, children: Node[], label = path.split("/").pop()!): Node => ({ id: `d:${path}`, label, kind: "folder", path, description: String(children.length), children });
const isBranch = (n: Node) => n.kind === "folder" || n.kind === "commit";
const tree = (): Node[] => [
  folder("src", [folder("src/api", [file("src/api/client.ts"), file("src/api/upload.ts", { oldPath: "src/api/send.ts" })]), file("src/index.ts")]),
  file("README.md"),
];
const shape = (rows: ReturnType<typeof flattenTree<Node>>) => rows.map((r) => `${"  ".repeat(r.depth - 1)}${r.node.label}${r.branch ? (r.expanded ? " -" : " +") : ""} ${r.posinset}/${r.setsize} ^${r.parent}`);

{
  const all = flattenTree(tree(), isBranch, () => true);
  assert.deepStrictEqual(shape(all), ["src - 1/2 ^-1", "  api - 1/2 ^0", "    client.ts 1/2 ^1", "    upload.ts 2/2 ^1", "  index.ts 2/2 ^0", "README.md 2/2 ^-1"]);
  const closed = new Set(["d:src/api"]);
  assert.deepStrictEqual(shape(flattenTree(tree(), isBranch, (n) => !closed.has(n.id))), ["src - 1/2 ^-1", "  api + 1/2 ^0", "  index.ts 2/2 ^0", "README.md 2/2 ^-1"]);
  assert.deepStrictEqual(flattenTree([], isBranch, () => true), []);
  // A commit not read yet is a branch with no rows under it.
  const commit: Node = { id: "c1", label: "fix: retry", kind: "commit" };
  assert.deepStrictEqual(shape(flattenTree([commit], isBranch, () => true)), ["fix: retry - 1/1 ^-1"]);
  console.log("ok - flattenTree: depth, parent, place among siblings, closed branches skipped");
}

const filterOptions: FilterOptions<Node> = {
  isBranch,
  isFile: (n) => n.kind === "file",
  text: (n) => (n.kind === "file" ? [n.label, n.path, n.oldPath] : n.kind === "commit" ? [n.label, n.description] : [n.label]),
  remake: (n, children, files) => ({ ...n, children, description: n.kind === "folder" ? String(files) : n.description }),
};
{
  const none = filterTree(tree(), "  ", filterOptions);
  assert.deepStrictEqual([none.matched, none.total], [4, 4]);
  assert.strictEqual(none.roots.length, 2);
  // A file by its name: its folders show with it, their counts say how many are shown.
  const upload = filterTree(tree(), "UPLOAD", filterOptions);
  assert.deepStrictEqual(shape(flattenTree(upload.roots, isBranch, () => true)), ["src - 1/1 ^-1", "  api - 1/1 ^0", "    upload.ts 1/1 ^1"]);
  assert.deepStrictEqual([upload.matched, upload.total], [1, 4]);
  assert.strictEqual(upload.roots[0].description, "1");
  // Its old path, with Windows separators.
  assert.strictEqual(filterTree(tree(), "api\\send", filterOptions).matched, 1);
  // A folder by its name: every file under it, as the host sent them.
  const host = tree();
  const api = filterTree(host, "api", filterOptions);
  assert.deepStrictEqual(shape(flattenTree(api.roots, isBranch, () => true)), ["src - 1/1 ^-1", "  api - 1/1 ^0", "    client.ts 1/2 ^1", "    upload.ts 2/2 ^1"]);
  assert.strictEqual(api.roots[0].children![0], host[0].children![0], "the matching folder is the host's own row");
  assert.notStrictEqual(api.roots[0], host[0], "its parent, shown in part, is a copy");
  // A folder's count is not its text: "1" finds no folder by its count.
  assert.strictEqual(filterTree([folder("lib", [file("lib/a.ts")])], "1", filterOptions).matched, 0);
  // A commit by its author: shown with all of its files.
  const commits: Node[] = [{ id: "c1", label: "fix: retry", kind: "commit", description: "dana · a42a50e", children: [file("x.ts"), file("y.ts")] }, { id: "c2", label: "feat: upload", kind: "commit", description: "rin · b31c920", children: [file("z.ts")] }];
  const byAuthor = filterTree(commits, "dana", filterOptions);
  assert.deepStrictEqual(byAuthor.roots.map((c) => [c.id, c.children?.length]), [["c1", 2]]);
  assert.deepStrictEqual([byAuthor.matched, byAuthor.total], [2, 3]);
  assert.deepStrictEqual(filterTree(tree(), "nothing", filterOptions), { roots: [], matched: 0, total: 4 });
  console.log("ok - filterTree: a row by its own text, its parents with only the matches, all under a match");
}

{
  assert.strictEqual(navigate("ArrowDown", -1, 5, 3), 0);
  assert.strictEqual(navigate("ArrowDown", 4, 5, 3), 4);
  assert.strictEqual(navigate("ArrowUp", 0, 5, 3), 0);
  assert.strictEqual(navigate("ArrowUp", -1, 5, 3), 0);
  assert.strictEqual(navigate("PageDown", 1, 5, 3), 4);
  assert.strictEqual(navigate("PageDown", 3, 5, 3), 4);
  assert.strictEqual(navigate("PageUp", 4, 5, 3), 1);
  assert.strictEqual(navigate("Home", 3, 5, 3), 0);
  assert.strictEqual(navigate("End", 0, 5, 3), 4);
  assert.strictEqual(navigate("ArrowDown", 0, 0, 3), null);
  assert.strictEqual(navigate("x", 0, 5, 3), null);
  console.log("ok - navigate: ↑ ↓ Home End PageUp PageDown stay inside the rows; ↓ from nothing is the first row");
}

{
  const rows = flattenTree(tree(), isBranch, (n) => n.id !== "d:src/api");
  // src(0, open) · api(1, closed) · index.ts(2) · README.md(3)
  const none = { shift: false, ctrl: false }, shift = { shift: true, ctrl: false }, ctrl = { shift: false, ctrl: true };
  assert.deepStrictEqual(treeKey(rows, 0, "ArrowDown", none, 10), { type: "move", index: 1, mode: "only" });
  assert.deepStrictEqual(treeKey(rows, 0, "ArrowDown", shift, 10), { type: "move", index: 1, mode: "range" });
  assert.deepStrictEqual(treeKey(rows, 0, "End", ctrl, 10), { type: "move", index: 3, mode: "focus" });
  // → on a closed folder opens it; on an open one goes to its first row; on a file does nothing.
  assert.deepStrictEqual(treeKey(rows, 1, "ArrowRight", none, 10), { type: "toggle", index: 1 });
  assert.deepStrictEqual(treeKey(rows, 0, "ArrowRight", none, 10), { type: "move", index: 1, mode: "only" });
  assert.strictEqual(treeKey(rows, 2, "ArrowRight", none, 10), null);
  // ← on an open folder closes it; elsewhere goes to the parent; at the top does nothing.
  assert.deepStrictEqual(treeKey(rows, 0, "ArrowLeft", none, 10), { type: "toggle", index: 0 });
  assert.deepStrictEqual(treeKey(rows, 1, "ArrowLeft", none, 10), { type: "move", index: 0, mode: "only" });
  assert.deepStrictEqual(treeKey(rows, 2, "ArrowLeft", none, 10), { type: "move", index: 0, mode: "only" });
  assert.strictEqual(treeKey(rows, 3, "ArrowLeft", none, 10), null);
  // Enter: a folder toggles, a file opens. Space: a folder toggles, a file is selected; Ctrl toggles it, Shift the range.
  assert.deepStrictEqual(treeKey(rows, 1, "Enter", none, 10), { type: "toggle", index: 1 });
  assert.deepStrictEqual(treeKey(rows, 2, "Enter", none, 10), { type: "open", index: 2 });
  assert.deepStrictEqual(treeKey(rows, 1, " ", none, 10), { type: "toggle", index: 1 });
  assert.deepStrictEqual(treeKey(rows, 2, " ", none, 10), { type: "select", index: 2, mode: "only" });
  assert.deepStrictEqual(treeKey(rows, 2, " ", ctrl, 10), { type: "select", index: 2, mode: "toggle" });
  assert.deepStrictEqual(treeKey(rows, 2, " ", shift, 10), { type: "select", index: 2, mode: "range" });
  assert.deepStrictEqual(treeKey(rows, 2, "a", ctrl, 10), { type: "selectAll" });
  assert.deepStrictEqual(treeKey(rows, 2, "A", ctrl, 10), { type: "selectAll" });
  // Nothing focused yet: only movement does something.
  assert.strictEqual(treeKey(rows, -1, "Enter", none, 10), null);
  assert.deepStrictEqual(treeKey(rows, -1, "ArrowDown", none, 10), { type: "move", index: 0, mode: "only" });
  assert.strictEqual(treeKey([], -1, "a", ctrl, 10), null);
  assert.strictEqual(treeKey(rows, 2, "Delete", none, 10), null);
  console.log("ok - treeKey: VS Code's list keys on folders and files");
}

{
  const ids = ["a", "b", "c", "d", "e"];
  let s = pick(ids, { selected: new Set() }, "b", "only");
  assert.deepStrictEqual([[...s.selected], s.focus, s.anchor], [["b"], "b", "b"]);
  s = pick(ids, s, "d", "range");
  assert.deepStrictEqual([[...s.selected], s.focus, s.anchor], [["b", "c", "d"], "d", "b"]);
  // Back over the anchor: the range is from the anchor, not from the last row.
  s = pick(ids, s, "a", "range");
  assert.deepStrictEqual([...s.selected], ["a", "b"]);
  s = pick(ids, s, "e", "toggle");
  assert.deepStrictEqual([[...s.selected], s.anchor], [["a", "b", "e"], "e"]);
  s = pick(ids, s, "a", "toggle");
  assert.deepStrictEqual([...s.selected], ["b", "e"]);
  // Ctrl+Shift-click adds the range to what is selected.
  s = pick(ids, pick(ids, { selected: new Set(["a"]) }, "c", "focus"), "c", "toggle");
  s = pick(ids, s, "d", "range", true);
  assert.deepStrictEqual([...s.selected].sort(), ["a", "c", "d"]);
  // Ctrl+↓ moves the focus alone.
  const moved = pick(ids, s, "e", "focus");
  assert.deepStrictEqual([[...moved.selected].sort(), moved.focus, moved.anchor], [["a", "c", "d"], "e", "c"]);
  // No anchor (or one no longer shown): the range is the row alone.
  assert.deepStrictEqual([...pick(ids, { selected: new Set(), anchor: "gone" }, "c", "range").selected], ["c"]);
  console.log("ok - pick: alone, toggled, a range from the anchor, focus alone");
}

{
  const s = { selected: new Set(["a", "b"]), focus: "b", anchor: "a" };
  const kept = keepShown(s, new Set(["a", "p"]), ["p", "q"]);
  assert.deepStrictEqual([[...kept.selected], kept.focus, kept.anchor], [["a"], "p", "a"]);
  const gone = keepShown(s, new Set(["x"]));
  assert.deepStrictEqual([[...gone.selected], gone.focus, gone.anchor], [[], undefined, undefined]);
  console.log("ok - keepShown: hidden rows leave the selection; a hidden focus goes to its shown parent");
}

{
  const labels = ["src", "README.md", "readme.txt", "retry.go", "upload.ts"];
  assert.strictEqual(findByPrefix(labels, -1, "r"), 1);
  assert.strictEqual(findByPrefix(labels, 1, "re"), 1, "a longer prefix keeps a row that still matches");
  assert.strictEqual(findByPrefix(labels, 1, "ret"), 3);
  // The same letter again: the next one, around the end.
  assert.strictEqual(findByPrefix(labels, 1, "rr"), 2);
  assert.strictEqual(findByPrefix(labels, 3, "rr"), 1);
  assert.strictEqual(findByPrefix(labels, 4, "u"), 4, "the only match stays");
  assert.strictEqual(findByPrefix(labels, 0, "zz"), -1);
  assert.strictEqual(findByPrefix([], 0, "a"), -1);
  console.log("ok - findByPrefix: type-to-find from the focused row, the same letter cycles");
}

{
  assert.deepStrictEqual(rowWindow(0, 100, 1000, 25, 2, 0), { start: 0, end: 4 });
  assert.deepStrictEqual(rowWindow(500, 100, 1000, 25, 2, 6), { start: 13, end: 30 });
  assert.deepStrictEqual(rowWindow(24900, 100, 1000, 25, 2, 6), { start: 989, end: 1000 });
  assert.deepStrictEqual(rowWindow(0, 0, 5, 25), { start: 0, end: 5 });
  assert.deepStrictEqual(rowWindow(0, 100, 0, 25), { start: 0, end: 0 });
  // Shown already: no move. Above: its top at the top. Below: its bottom at the bottom.
  assert.strictEqual(scrollToShow(100, 200, 5, 25, 2), 100);
  assert.strictEqual(scrollToShow(100, 200, 2, 25, 2), 52);
  assert.strictEqual(scrollToShow(100, 200, 20, 25, 2), 327);
  assert.strictEqual(scrollToShow(0, 0, 3, 25, 2), 102);
  console.log("ok - rowWindow and scrollToShow: the rows on screen, a row scrolled into view by arithmetic");
}
