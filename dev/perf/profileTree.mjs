// Where scrolling the Log spends its script time, by function and including callees, plus who
// calls the layout-forcing reads. Dev-only, like scrollBench.mjs (build the harness first):
//   node dev/perf/profileTree.mjs [--dist <dir>] [--state many] [--rows 2000] [--cpu 4]
// Also counts the DOM nodes of the rows on screen, by element, so a heavier row shows up.
import { chromium } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const ROWS = Number(flag("rows", 2000)), CPU = Number(flag("cpu", 4)), STATE = flag("state", "many");
const dist = path.resolve(flag("dist", path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "dist")));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const server = createServer((req, res) => {
  const file = path.join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(0, "127.0.0.1");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?theme=dark&state=${STATE}&date=all${process.argv.includes("--keys") ? "&keys=1" : ""}`);
await page.locator("#rows .row").first().waitFor();
for (;;) {
  const n = Number(await page.evaluate(() => document.getElementById("list").getAttribute("aria-rowcount")));
  if (n >= ROWS || !(await page.locator("#more").isVisible())) break;
  await page.locator("#more").click();
  await page.waitForFunction((before) => Number(document.getElementById("list").getAttribute("aria-rowcount")) > before, n);
}
const census = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#rows .row")];
  const tags = {};
  let total = 0;
  for (const row of rows) for (const el of row.querySelectorAll("*")) { total++; tags[el.tagName.toLowerCase()] = (tags[el.tagName.toLowerCase()] ?? 0) + 1; }
  return { rows: rows.length, perRow: total / rows.length, tags: Object.fromEntries(Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 8)) };
});
await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
await cdp.send("Profiler.start");
await page.evaluate(async () => {
  const list = document.getElementById("list");
  const keys = location.search.includes("keys=1");
  if (keys) { list.focus(); list.querySelector(".row[data-index]")?.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
  for (let i = 0; i < 240; i++) { if (keys) list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); else list.scrollTop += 120; await new Promise((r) => requestAnimationFrame(r)); }
});
const { profile } = await cdp.send("Profiler.stop");
await browser.close();
server.close();

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const name = (n) => { const f = n.callFrame; return `${f.functionName || "(anonymous)"}${f.url ? ` ${path.basename(f.url)}:${f.lineNumber + 1}` : ""}`; };
const inclusive = new Map(), callers = new Map();
profile.samples.forEach((id, i) => {
  const ms = (profile.timeDeltas[i] ?? 0) / 1000;
  const seen = new Set();
  for (let at = id; at !== undefined; at = parent.get(at)) {
    const key = name(byId.get(at));
    if (!seen.has(key)) { inclusive.set(key, (inclusive.get(key) ?? 0) + ms); seen.add(key); }
  }
  const leaf = byId.get(id);
  if (/getBoundingClientRect|getComputedStyle|offsetWidth|scrollTop/.test(leaf.callFrame.functionName)) {
    const up = byId.get(parent.get(id));
    const key = `${leaf.callFrame.functionName} ← ${up ? name(up) : "?"}`;
    callers.set(key, (callers.get(key) ?? 0) + ms);
  }
});
console.log(`rows on screen ${census.rows}, ${census.perRow.toFixed(1)} elements per row:`, census.tags);
console.log("\nincluding callees (webview.js):");
for (const [k, ms] of [...inclusive].filter(([k]) => k.includes("webview.js")).sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${k}`);
console.log("\nlayout reads by caller:");
for (const [k, ms] of [...callers].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${k}`);
