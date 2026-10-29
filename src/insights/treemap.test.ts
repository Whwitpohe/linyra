import * as assert from "assert";
import { buildTree, extOf, findNode, heatLegend, heatLevel, heatSteps, keysOf, layoutTreemap, nearestTile, pruneTree, rankExtensions, squarify, type Rect } from "./treemap";

const area = (r: Rect) => r.w * r.h;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// ── The squarified layout: areas in proportion, no overlap, close to square ──
{
  // The paper's example: 6, 6, 4, 3, 2, 2, 1 in a 6×4 rectangle.
  const values = [6, 6, 4, 3, 2, 2, 1];
  const rect = { x: 0, y: 0, w: 6, h: 4 };
  const rects = squarify(values, rect);
  rects.forEach((r, i) => assert.ok(near(area(r), values[i]), `area ${i}: ${area(r)} for ${values[i]}`));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(overlap(rects[i], rects[j]) < 1e-9, `${i} and ${j} overlap`);
  assert.ok(rects.every((r) => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 6 + 1e-9 && r.y + r.h <= 4 + 1e-9), "inside the rectangle");
  const worst = Math.max(...rects.map((r) => Math.max(r.w / r.h, r.h / r.w)));
  assert.ok(worst < 3, `aspect ratios stay low (worst ${worst.toFixed(2)})`);
  assert.deepStrictEqual([rects[0].w, rects[0].h].map((n) => Number(n.toFixed(6))), [3, 2], "the first two share the left half as 3×2 squares");

  const zero = squarify([5, 0, 5], { x: 10, y: 10, w: 100, h: 50 });
  assert.strictEqual(area(zero[1]), 0, "a zero value gets no area");
  assert.ok(near(area(zero[0]) + area(zero[2]), 5000));
  assert.deepStrictEqual(squarify([1, 2], { x: 0, y: 0, w: 0, h: 10 }).map(area), [0, 0]);
  const many = squarify(Array.from({ length: 500 }, (_, i) => 500 - i), { x: 0, y: 0, w: 900, h: 500 });
  assert.ok(near(many.reduce((s, r) => s + area(r), 0), 450_000, 1e-6), "500 tiles fill the rectangle exactly");
  console.log("ok - the squarified layout keeps areas in proportion, without overlap, near-square");
}

// ── The tree: repositories, folders, files; one repository is its own root ──
{
  const repos = [
    { id: "/work/acme-web", name: "acme-web", entries: [{ path: "src/client.ts", value: 800 }, { path: "src/app/main.ts", value: 200 }, { path: "README.md", value: 100 }, { path: "empty.txt", value: 0 }] },
    { id: "/work/acme-api", name: "acme-api", entries: [{ path: "upload.go", value: 300 }] },
  ];
  const root = buildTree(repos);
  assert.deepStrictEqual([root.kind, root.value, root.files], ["root", 1400, 4], "an empty file has no area and is left out");
  const web = findNode(root, ["/work/acme-web"])!;
  assert.deepStrictEqual([web.kind, web.name, web.value, web.files], ["repo", "acme-web", 1100, 3]);
  const src = findNode(root, ["/work/acme-web", "src"])!;
  assert.deepStrictEqual([src.kind, src.value, src.files, src.path], ["folder", 1000, 2, "src"]);
  assert.deepStrictEqual(findNode(root, ["/work/acme-web", "src", "app", "main.ts"])?.path, "src/app/main.ts");
  assert.deepStrictEqual(keysOf(root, "/work/acme-web", "src/app"), ["/work/acme-web", "src", "app"]);
  assert.strictEqual(keysOf(root, "/work/acme-web", "gone"), undefined);
  const one = buildTree([repos[1]]);
  assert.deepStrictEqual([one.kind, one.name, keysOf(one, "/work/acme-api", "")], ["repo", "acme-api", []], "one repository: it is the root");
  assert.strictEqual(buildTree([{ id: "r", name: "r", entries: [] }]).value, 0);

  const msg = pruneTree(root, 2);
  assert.deepStrictEqual(msg.children!.map((c) => [c.name, c.value]), [["acme-web", 1100], ["acme-api", 300]], "biggest first");
  const webMsg = msg.children![0];
  assert.deepStrictEqual(webMsg.children!.map((c) => [c.name, c.kind]), [["src", "folder"], ["README.md", "file"]]);
  assert.strictEqual(webMsg.children![0].more, true, "two levels down: src's children are not sent, it says there are more");
  assert.strictEqual(webMsg.children![0].children, undefined);
  assert.deepStrictEqual([webMsg.children![1].ext, webMsg.children![1].path, webMsg.children![1].repoId], ["md", "README.md", "/work/acme-web"]);

  const wide = buildTree([{ id: "r", name: "r", entries: Array.from({ length: 300 }, (_, i) => ({ path: `f${i}.ts`, value: 1000 - i })) }]);
  const capped = pruneTree(wide, 3, 50);
  assert.strictEqual(capped.children!.length, 50, "49 files and one rest");
  const rest = capped.children!.at(-1)!;
  assert.deepStrictEqual([rest.kind, rest.files], ["rest", 251]);
  assert.strictEqual(rest.value, Array.from({ length: 251 }, (_, i) => 1000 - 49 - i).reduce((a, b) => a + b, 0));
  const tight = pruneTree(buildTree([{ id: "r", name: "r", entries: Array.from({ length: 40 }, (_, i) => ({ path: `d${i % 4}/f${i}.ts`, value: 10 })) }]), 3, 200, 6);
  const sent = (m: typeof tight): number => (m.children ?? []).reduce((s, c) => s + 1 + sent(c), 0);
  assert.ok(sent(tight) <= 6 + 1, `the budget caps what is sent (${sent(tight)})`);
  assert.strictEqual(tight.children!.length, 4, "breadth first: the top level is complete");
  assert.ok(tight.children!.some((c) => c.more), "the folders the budget did not reach say there are more");
  console.log("ok - the tree holds repositories, folders and files; a view sends its biggest children, a budget at most");
}

// ── File types and heat ───────────────────────────────────────────────────
{
  assert.deepStrictEqual(["src/a.TS", "a.test.ts", ".gitignore", "Makefile", "dir.v2/file", "x."].map(extOf), ["ts", "ts", "", "", "", ""]);
  const ranked = rankExtensions([{ path: "a.ts", value: 50 }, { path: "b.ts", value: 50 }, { path: "c.png", value: 300 }, { path: "Makefile", value: 10 }, { path: "d.md", value: 0 }], 2);
  assert.deepStrictEqual(ranked, [{ ext: "png", value: 300 }, { ext: "ts", value: 100 }]);

  const values = [1, 1, 1, 1, 1, 1, 2, 3, 5, 40];
  const steps = heatSteps(values);
  assert.deepStrictEqual(steps, [2, 3, 40], "the top 40%, 30% and 10% of ten files: four, three and one");
  assert.deepStrictEqual(values.map((v) => heatLevel(v, steps)), [0, 0, 0, 0, 0, 0, 1, 2, 2, 3]);
  assert.deepStrictEqual(heatSteps([1, 1, 1]).map((s) => heatLevel(1, [s])), [0, 0, 0], "every file touched once: nothing is hot");
  assert.deepStrictEqual(heatSteps([]), []);
  assert.deepStrictEqual(heatLegend([2, 3, 40]), [{ level: 0, from: 1, to: 1 }, { level: 1, from: 2, to: 2 }, { level: 2, from: 3, to: 39 }, { level: 3, from: 40 }]);
  assert.deepStrictEqual(heatLegend([5, 5, 35]), [{ level: 0, from: 1, to: 4 }, { level: 2, from: 5, to: 34 }, { level: 3, from: 35 }], "a level no tile can reach is left out");
  assert.deepStrictEqual(heatLegend([]), [{ level: 0, from: 1 }]);
  console.log("ok - file types rank by bytes; heat steps start above the commonest count");
}

// ── Nested layout and the keyboard ────────────────────────────────────────
{
  const root = pruneTree(buildTree([{ id: "r", name: "acme-web", entries: [
    { path: "src/client.ts", value: 600 }, { path: "src/api.ts", value: 200 }, { path: "docs/guide.md", value: 150 }, { path: "tiny.txt", value: 1 }] }]));
  const tiles = layoutTreemap(root, { x: 0, y: 0, w: 400, h: 300 });
  const src = tiles.find((t) => t.node.name === "src")!;
  assert.ok(src.frame && src.label, "a big folder is a frame with its name");
  const inSrc = tiles.filter((t) => t.depth === 2 && t.node.path?.startsWith("src/"));
  assert.strictEqual(inSrc.length, 2);
  assert.ok(inSrc.every((t) => t.x >= src.x && t.y >= src.y + 18 - 1e-9 && t.x + t.w <= src.x + src.w + 1e-9 && t.y + t.h <= src.y + src.h + 1e-9), "its files lie inside, under the header");
  assert.ok(tiles.indexOf(src) < tiles.indexOf(inSrc[0]), "parents first, so they draw underneath");
  assert.ok(!tiles.some((t) => t.node.name === "tiny.txt"), "a tile under 2px is not drawn");
  const small = layoutTreemap(root, { x: 0, y: 0, w: 60, h: 30 });
  assert.ok(small.filter((t) => t.depth === 1).every((t) => !t.frame), "no room: folders are plain tiles");

  const grid: Rect[] = [{ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }, { x: 0, y: 10, w: 10, h: 10 }, { x: 10, y: 10, w: 10, h: 10 }];
  assert.strictEqual(nearestTile(grid, 0, "ArrowRight"), 1);
  assert.strictEqual(nearestTile(grid, 0, "ArrowDown"), 2);
  assert.strictEqual(nearestTile(grid, 3, "ArrowLeft"), 2);
  assert.strictEqual(nearestTile(grid, 3, "ArrowUp"), 1);
  assert.strictEqual(nearestTile(grid, 0, "ArrowLeft"), undefined, "the edge");
  console.log("ok - nested tiles lie in their frames; arrow keys move to the nearest tile that way");
}
