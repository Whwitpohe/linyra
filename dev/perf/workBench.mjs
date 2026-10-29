// How much work an interaction costs the webview, not how long it took: Chrome's own counters
// (script, style, layout) summed over many tries, so a build compares with another without the
// noise of wall-clock timing (scrolling has its own: scrollBench.mjs). Dev-only; build the harness first:
//   node dev/perf/workBench.mjs [--dist <dir>] [--tries 20] [--state many]
import { chromium } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const flag = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const TRIES = Number(flag("tries", 20)), STATE = flag("state", "many");
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
await cdp.send("Performance.enable");

/** Each case's input; the tick waits for the Log's new rows, the others for two frames. */
const repoBox = `#repo-rows .repo-row[aria-expanded]:not(.tree-group)`;
const cases = {
  "tick a repository (Log reloads)": { act: `document.querySelector("${repoBox} .repo-check").dispatchEvent(new MouseEvent("click", { bubbles: true }))`, rows: true },
  "expand a repository (Repo List)": { act: `document.querySelector("${repoBox} .tree-twisty").dispatchEvent(new MouseEvent("click", { bubbles: true }))` },
  "select a row": { act: `const r = [...document.querySelectorAll("#rows .row[data-index]")]; r[Math.floor(Math.random() * r.length)].querySelector(".subject").dispatchEvent(new MouseEvent("click", { bubbles: true }))` },
  "type a letter in Search": { act: `const s = document.getElementById("search"); s.focus(); s.value += "a"; s.dispatchEvent(new Event("input", { bubbles: true }))` },
};
const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
const KEYS = { ScriptDuration: "script", RecalcStyleDuration: "style", LayoutDuration: "layout", LayoutCount: "layouts", RecalcStyleCount: "styles" };

console.log(`state=${STATE}, ${TRIES} tries each, per try (ms of the main thread; layouts and style passes as counts):`);
for (const [name, { act, rows }] of Object.entries(cases)) {
  const before = await metrics();
  for (let i = 0; i < TRIES; i++) {
    await page.evaluate(async ({ src, rows }) => {
      const list = document.getElementById("rows");
      const changed = rows ? new Promise((r) => new MutationObserver((_, o) => { o.disconnect(); r(); }).observe(list, { childList: true })) : null;
      (0, eval)(`(() => { ${src} })`)();
      if (changed) await Promise.race([changed, new Promise((r) => setTimeout(r, 3000))]);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, { src: act, rows });
    await page.waitForTimeout(rows ? 350 : 120);
  }
  const after = await metrics();
  const cell = (k) => { const d = (after[k] - before[k]) / TRIES; return k.endsWith("Count") ? d.toFixed(1) : (d * 1000).toFixed(1); };
  console.log(`  ${name.padEnd(34)} ${Object.entries(KEYS).map(([k, label]) => `${label} ${cell(k).padStart(6)}`).join("  ")}`);
}
await browser.close();
server.close();
