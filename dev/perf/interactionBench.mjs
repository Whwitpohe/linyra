// How long the Log's common interactions take, from the input to the frame that shows the result,
// in the browser harness (CPU slowed like a busy VS Code window). Dev-only; build the harness first:
//   node dev/perf/interactionBench.mjs [--dist <dir>] [--cpu 4] [--reps 12] [--state many]
// Each number is the median of --reps tries; "frame" waits two animation frames after the input.
import { chromium } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const CPU = Number(flag("cpu", 4)), REPS = Number(flag("reps", 12)), STATE = flag("state", "many");
const dist = path.resolve(flag("dist", path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "dist")));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".map": "application/json" };
const server = createServer((req, res) => {
  const file = path.join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(dist) || !existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(0);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await page.goto(`http://localhost:${server.address().port}/index.html?theme=dark&state=${STATE}&date=all&avatars=off`);
await page.locator("#rows .row").first().waitFor();
await page.waitForTimeout(500);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });

/** Runs `act` in the page and waits two frames; returns the elapsed ms. */
const time = (act) => page.evaluate(async (src) => {
  const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await frames();
  const t = performance.now();
  await (0, eval)(src)();
  await frames();
  return performance.now() - t;
}, `(async () => { ${act} })`);
const settle = () => page.waitForTimeout(250);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const cases = {
  "select a row (click)": `const rows = [...document.querySelectorAll("#rows .row[data-index]")]; rows[Math.floor(Math.random() * rows.length)].querySelector(".subject").dispatchEvent(new MouseEvent("click", { bubbles: true }));`,
  "move the selection (↓)": `const list = document.getElementById("list"); list.focus(); list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));`,
  "type a letter in Search": `const s = document.getElementById("search"); s.focus(); s.value += "a"; s.dispatchEvent(new Event("input", { bubbles: true }));`,
  "clear Search": `const s = document.getElementById("search"); s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true })); s.blur();`,
  "open the author picker": `document.getElementById("author").click();`,
  "close a picker (Escape)": `document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));`,
  "open the branch picker": `document.getElementById("branch").click();`,
  "switch to Uncommitted": `document.getElementById("mode-work").click();`,
  "switch back to Commits": `document.getElementById("mode-commits").click();`,
  "expand a repository (Repo List)": `document.querySelector("#repo-rows .repo-row .tree-twisty")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));`,
  "open the ⋯ menu": `document.getElementById("toolbar-more").click();`,
  "close the ⋯ menu": `document.getElementById("toolbar-more").click();`,
};
// --profile "<case>": that case only, 30 tries under the sampling profiler; prints time by function.
const profiled = flag("profile", "");
if (profiled) {
  const act = cases[profiled];
  if (!act) throw new Error(`no case "${profiled}"; cases: ${Object.keys(cases).join(", ")}`);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await cdp.send("Profiler.start");
  for (let i = 0; i < 30; i++) { await time(act); await settle(); }
  const { profile } = await cdp.send("Profiler.stop");
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const label = (n) => `${n.callFrame.functionName || "(anonymous)"}${n.callFrame.url ? ` ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber + 1}` : ""}`;
  const inclusive = new Map(), self = new Map();
  profile.samples.forEach((id, i) => {
    const ms = (profile.timeDeltas[i] ?? 0) / 1000;
    self.set(label(byId.get(id)), (self.get(label(byId.get(id))) ?? 0) + ms);
    const seen = new Set();
    for (let at = id; at !== undefined; at = parent.get(at)) { const k = label(byId.get(at)); if (!seen.has(k)) { inclusive.set(k, (inclusive.get(k) ?? 0) + ms); seen.add(k); } }
  });
  console.log(`${profiled}: 30 tries, including callees (webview.js):`);
  for (const [k, ms] of [...inclusive].filter(([k]) => /webview\.js|shim\.js/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 26)) console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${k}`);
  console.log("self:");
  for (const [k, ms] of [...self].filter(([k]) => !/^\((program|idle)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${ms.toFixed(0).padStart(6)} ms  ${k}`);
  await browser.close();
  server.close();
  process.exit(0);
}
const results = {};
for (const [name, act] of Object.entries(cases)) {
  const xs = [];
  for (let i = 0; i < REPS; i++) { xs.push(await time(act)); await settle(); }
  results[name] = median(xs);
}
// Ticking a repository reloads the Log: measured to the first frame after the new rows are in.
{
  const xs = [];
  for (let i = 0; i < Math.min(REPS, 6); i++) {
    xs.push(await page.evaluate(async () => {
      const rows = document.getElementById("rows");
      const box = document.querySelector("#repo-rows .repo-row[data-key] .repo-check, #repo-rows .repo-row .repo-check");
      const t = performance.now();
      const changed = new Promise((r) => new MutationObserver((_, o) => { o.disconnect(); r(); }).observe(rows, { childList: true }));
      box?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.race([changed, new Promise((r) => setTimeout(r, 3000))]);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return performance.now() - t;
    }));
    await page.waitForTimeout(400);
  }
  results["tick a repository (to new rows)"] = median(xs);
}
await browser.close();
server.close();
console.log(`CPU ×${CPU}, state=${STATE}, median of ${REPS} tries (ms, input → painted frame):`);
for (const [name, ms] of Object.entries(results)) console.log(`  ${ms.toFixed(0).padStart(5)}  ${name}`);
