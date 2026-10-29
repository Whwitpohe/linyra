// Measures scrolling the Log in the browser harness: frame times, and the main thread's script,
// style and layout time per frame (Chrome's own counters), on a merged history of 68 repositories.
// Dev-only. Run `node dev/harness/build.mjs` first, then:
//   node dev/perf/scrollBench.mjs [--rows 2000] [--cpu 4] [--step 120] [--frames 240] [--runs 3] [--profile] [--dist <dir>] [--chatter <ms>] [--keys] [--state many]
// --cpu slows the CPU like a busy VS Code window; --profile prints the functions that took the time;
// --dist measures another build of the harness (an older commit's, to compare); --chatter sends the
// Log an "uncommitted" message every <ms> while it scrolls, as VS Code's Git reporting changes does;
// --keys holds ↓ instead of scrolling (one selection move per frame); --state picks the harness scenario
// ("long": three repositories with deep history, whose graph draws author discs rather than dots).
import { chromium } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : Number(process.argv[i + 1]);
};
const ROWS = arg("rows", 2000), CPU = arg("cpu", 4), STEP = arg("step", 120), FRAMES = arg("frames", 240), RUNS = arg("runs", 3);
const stateFlag = process.argv.indexOf("--state"), STATE = stateFlag >= 0 ? process.argv[stateFlag + 1] : "many";
const PROFILE = process.argv.includes("--profile"), KEYS = process.argv.includes("--keys"), CHATTER = arg("chatter", 0);
const distFlag = process.argv.indexOf("--dist");
const dist = distFlag >= 0 ? path.resolve(process.argv[distFlag + 1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "dist");
if (!existsSync(path.join(dist, "index.html"))) throw new Error("build the harness first: node dev/harness/build.mjs");

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const server = createServer((req, res) => {
  const file = path.join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Performance.enable");
await page.goto(`http://localhost:${port}/index.html?theme=dark&state=${STATE}&date=all`);
await page.locator("#rows .row").first().waitFor();
// Page in until the list holds ROWS commits (the harness serves 200 per page).
for (;;) {
  const n = await page.evaluate(() => document.getElementById("list").getAttribute("aria-rowcount"));
  if (Number(n) >= ROWS) break;
  const more = page.locator("#more");
  if (!(await more.isVisible())) break;
  await more.click();
  await page.waitForFunction((before) => Number(document.getElementById("list").getAttribute("aria-rowcount")) > before, Number(n));
}
const rows = Number(await page.evaluate(() => document.getElementById("list").getAttribute("aria-rowcount")));
await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });

const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
async function scroll(direction) {
  return page.evaluate(async ({ frames, step, chatter, keys }) => {
    const list = document.getElementById("list");
    const times = [];
    if (keys) { list.focus(); list.querySelector(".row[data-index]")?.dispatchEvent(new MouseEvent("click", { bubbles: true })); }
    const work = { type: "uncommitted", known: true, totals: { files: 5, repos: 3, added: 24, deleted: 5 }, rows: [] };
    const timer = chatter > 0 ? setInterval(() => window.postMessage(work, "*"), chatter) : undefined;
    let last = await new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < frames; i++) {
      if (keys) list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      else list.scrollTop += step;
      const now = await new Promise((r) => requestAnimationFrame(r));
      times.push(now - last);
      last = now;
    }
    clearInterval(timer);
    return times;
  }, { frames: FRAMES, step: STEP * direction, chatter: CHATTER, keys: KEYS });
}

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const results = [];
for (let run = 0; run < RUNS; run++) {
  await page.evaluate(() => { document.getElementById("list").scrollTop = 0; });
  await page.waitForTimeout(300);
  const before = await metrics();
  if (PROFILE && run === RUNS - 1) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 200 }); await cdp.send("Profiler.start"); }
  const times = await scroll(1);
  const profile = PROFILE && run === RUNS - 1 ? (await cdp.send("Profiler.stop")).profile : undefined;
  const after = await metrics();
  const per = (name) => ((after[name] - before[name]) * 1000) / times.length;
  results.push({
    frameMedian: pct(times, 0.5), frameP95: pct(times, 0.95), frameMax: Math.max(...times),
    over33: times.filter((t) => t > 33.4).length, over50: times.filter((t) => t > 50).length,
    scriptPerFrame: per("ScriptDuration"), stylePerFrame: per("RecalcStyleDuration"), layoutPerFrame: per("LayoutDuration"), taskPerFrame: per("TaskDuration"),
    layoutsPerFrame: (after.LayoutCount - before.LayoutCount) / times.length, stylesPerFrame: (after.RecalcStyleCount - before.RecalcStyleCount) / times.length,
    nodes: after.Nodes,
  });
  if (profile) {
    const self = new Map();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => {
      const n = byId.get(id);
      const f = n.callFrame;
      const key = `${f.functionName || "(anonymous)"} ${f.url ? `${path.basename(f.url)}:${f.lineNumber + 1}` : ""}`.trim();
      self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
    });
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    console.log("\nself time, last run:");
    for (const [k, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`  ${ms.toFixed(0).padStart(6)} ms ${((ms / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
}
await browser.close();
server.close();

const med = (key) => pct(results.map((r) => r[key]), 0.5);
const f1 = (x) => x.toFixed(1);
console.log(`\n${rows} rows, CPU ×${CPU}, ${FRAMES} frames of ${KEYS ? "↓" : `${STEP}px`}${CHATTER ? `, a host message every ${CHATTER} ms` : ""}, median of ${RUNS} runs`);
console.log(`frame: median ${f1(med("frameMedian"))} ms, p95 ${f1(med("frameP95"))} ms, max ${f1(med("frameMax"))} ms, >33 ms ${med("over33")}, >50 ms ${med("over50")}`);
console.log(`per frame: task ${f1(med("taskPerFrame"))} ms = script ${f1(med("scriptPerFrame"))} + style ${f1(med("stylePerFrame"))} + layout ${f1(med("layoutPerFrame"))} ms; ${f1(med("layoutsPerFrame"))} layouts, ${f1(med("stylesPerFrame"))} style recalcs; ${med("nodes")} DOM nodes`);
