// How long the file trees take with many files, in the browser harness (CPU slowed like a busy VS
// Code window): the Changes view's 301 files (changes.html?state=many) and Compare's 480 on a side
// (repos.html?files=many). Dev-only; build the harness first:
//   node dev/perf/fileTreeBench.mjs [--dist <dir>] [--cpu 4] [--reps 8] [--keys 60]
// Each number is the median of --reps tries, from the input to two animation frames after it;
// "hold ↓" is the mean per press of --keys presses, one per frame, and the longest one.
import { chromium } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const CPU = Number(flag("cpu", 4)), REPS = Number(flag("reps", 8)), KEYS = Number(flag("keys", 60));
const dist = path.resolve(flag("dist", path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "dist")));
if (!existsSync(path.join(dist, "changes.html"))) throw new Error("build the harness first: node dev/harness/build.mjs");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const server = createServer((req, res) => {
  const file = path.join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(0, "127.0.0.1");
const browser = await chromium.launch();
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const views = [
  { name: "Changes (301 files)", url: "changes.html?theme=dark&state=many", tree: "#file-tree", filter: "#file-filter", toggle: "#changes-tree-toggle", term: "homev", message: "changes" },
  { name: "Compare side (480 files)", url: "repos.html?theme=dark&files=many", tree: "#compare-left-tree", filter: "#compare-left-filter", toggle: "#compare-left-tree-toggle", term: "part-3", message: "side" },
];

const results = [];
for (const v of views) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  // The page the host sent, kept to send again under a new key (a first render, every time).
  await page.addInitScript(() => window.addEventListener("message", (e) => {
    if ((e.data?.type === "changes" || (e.data?.type === "side" && e.data.side === "left")) && !String(e.data.key).startsWith("bench-")) window.__benchPage = e.data;
  }));
  await page.goto(`http://127.0.0.1:${server.address().port}/${v.url}`);
  await page.locator(`${v.tree} [role="treeitem"]`).nth(20).waitFor();
  await page.waitForTimeout(400);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  const time = (act, arg) => page.evaluate(async ([src, a]) => {
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await frames();
    const t = performance.now();
    await (0, eval)(src)(a);
    await frames();
    return performance.now() - t;
  }, [`(async (a) => { ${act} })`, arg]);
  const row = {};
  const render = [];
  for (let i = 0; i < REPS; i++) render.push(await time(`window.dispatchEvent(new MessageEvent("message", { data: { ...window.__benchPage, key: "bench-" + a } }));`, i));
  row["first render"] = median(render);
  // Back to the host's own key: its later pages (Compare sends both sides again on Expand All) keep the tree as it is.
  await time(`window.dispatchEvent(new MessageEvent("message", { data: window.__benchPage }));`);
  const collapse = [], expand = [];
  for (let i = 0; i < REPS; i++) {
    // The trees open fully expanded: the toggle collapses first, then expands.
    collapse.push(await time(`document.querySelector(${JSON.stringify(v.toggle)}).click();`));
    expand.push(await time(`document.querySelector(${JSON.stringify(v.toggle)}).click();`));
  }
  row["collapse all"] = median(collapse);
  row["expand all"] = median(expand);
  const keystroke = [];
  for (let i = 0; i < Math.max(2, REPS / 2); i++) {
    for (let n = 1; n <= v.term.length; n++) {
      keystroke.push(await time(`const f = document.querySelector(${JSON.stringify(v.filter)}); f.value = a; f.dispatchEvent(new Event("input", { bubbles: true }));`, v.term.slice(0, n)));
    }
    await time(`const f = document.querySelector(${JSON.stringify(v.filter)}); f.value = ""; f.dispatchEvent(new Event("input", { bubbles: true }));`);
  }
  row["filter keystroke"] = median(keystroke);
  row["clear filter"] = await time(`const f = document.querySelector(${JSON.stringify(v.filter)}); f.value = "x"; f.dispatchEvent(new Event("input", { bubbles: true })); f.value = ""; f.dispatchEvent(new Event("input", { bubbles: true }));`);
  // Hold ↓: one press a frame from the first row; the mean per press and the longest one.
  const hold = await page.evaluate(async ([sel, keys]) => {
    const tree = document.querySelector(sel);
    tree.focus();
    tree.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    await frame(); await frame();
    const steps = [];
    const start = performance.now();
    for (let i = 0; i < keys; i++) {
      const t = performance.now();
      tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await frame();
      steps.push(performance.now() - t);
    }
    return { mean: (performance.now() - start) / keys, max: Math.max(...steps) };
  }, [v.tree, KEYS]);
  row["hold ↓ (mean/press)"] = hold.mean;
  row["hold ↓ (longest)"] = hold.max;
  row["rows in DOM"] = await page.locator(`${v.tree} [role="treeitem"]`).count();
  results.push([v.name, row]);
  await page.close();
}
await browser.close();
server.close();
const cases = Object.keys(results[0][1]);
console.log(`CPU ×${CPU}, median of ${REPS} (ms)\n`);
console.log(["case".padEnd(22), ...results.map(([n]) => n.padStart(26))].join(""));
for (const c of cases) console.log([c.padEnd(22), ...results.map(([, r]) => (c === "rows in DOM" ? String(r[c]) : r[c].toFixed(1)).padStart(26))].join(""));
