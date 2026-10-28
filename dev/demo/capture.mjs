// Captures the real VS Code workbench and production webviews. No HTML mockups.
// Optional LINYRA_CAPTURE_NODE_MODULES supplies preinstalled playwright + sharp.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, closeSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { webviewDriver } from "./webviewDriver.mjs";
import { recordFeatures } from "./features.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(process.env.LINYRA_CAPTURE_NODE_MODULES
  ? join(process.env.LINYRA_CAPTURE_NODE_MODULES, "package.json") : import.meta.url);
const { chromium } = require("playwright");
const sharp = require("sharp");
const workspace = resolve(process.env.LINYRA_DEMO_DIR ?? join(tmpdir(), "linyra-demo-v141"));
const control = join(workspace, ".capture", process.env.LINYRA_CAPTURE_RUN ?? `run-${Date.now()}`);
const output = resolve(process.env.LINYRA_CAPTURE_OUTPUT ?? join(root, "dev/demo/out"));
const port = Number(process.env.LINYRA_CAPTURE_PORT ?? 9337);
const locale = process.env.LINYRA_CAPTURE_LANGUAGE ?? "en";
mkdirSync(control, { recursive: true });
console.log("Isolated recording control:",control);
for (const name of ["ready.json", "request.json", "response.json"]) rmSync(join(control,name), { force:true });
mkdirSync(output, { recursive: true });
mkdirSync(join(control, "profile/User"), { recursive: true });
writeFileSync(join(control, "profile/User/settings.json"), JSON.stringify({
  "workbench.colorTheme": "Default Dark Modern", "workbench.startupEditor": "none",
  "window.titleBarStyle": "custom", "window.commandCenter": false,
  "workbench.layoutControl.enabled": false, "chat.commandCenter.enabled": false,
  "chat.disableAIFeatures": true, "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.tips.enabled": false, "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "update.mode": "none", "telemetry.telemetryLevel": "off", "security.workspace.trust.enabled": false,
  "extensions.ignoreRecommendations": true, "window.restoreWindows": "none",
  "workbench.enableExperiments": false, "editor.fontSize": 13, "terminal.integrated.fontSize": 13,
  "window.newWindowDimensions": "maximized", "window.zoomLevel": 0.35,
  "git.openRepositoryInParentFolders": "never", "editor.minimap.enabled": false,
  "breadcrumbs.enabled": false, "problems.decorations.enabled": false,
  "workbench.statusBar.visible": false, "workbench.activityBar.location": "hidden",
}, null, 2));
const code = process.env.LINYRA_CAPTURE_CODE ?? await downloadAndUnzipVSCode("stable");
const log = await import("node:fs").then(fs => fs.openSync(join(control, "code.log"), "w"));
const child = spawn(code, [
  join(workspace, "acme.code-workspace"), "--new-window",
  `--locale=${locale}`,
  "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", "--no-sandbox",
  "--user-data-dir", join(control, "profile"), "--extensions-dir", join(control, "extensions"),
  "--extensionDevelopmentPath", root, "--extensionTestsPath", join(root, "out/demo/captureHost.js"),
  `--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1",
], { cwd: root, windowsHide: false, stdio: ["ignore", log, log], env: {
  ...process.env, HOME: join(workspace, ".home"), USERPROFILE: join(workspace, ".home"),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(workspace, ".home/.gitconfig"),
  LINYRA_ITEST: "1", LINYRA_CAPTURE_CONTROL: control,
} });
closeSync(log);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(label, probe, timeout = 60000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { const value = await probe(); if (value) return value; await sleep(150); }
  throw new Error(`Timed out: ${label}`);
}
let sequence = 0;
async function call(op, values = {}) {
  const id = ++sequence;
  writeFileSync(join(control, "request.json"), JSON.stringify({ id, op, ...values }));
  return waitFor(op, async () => {
    try { const r = JSON.parse(readFileSync(join(control, "response.json"), "utf8"));
      if (r.id !== id) return false; if (r.error) throw new Error(r.error); return { value: r.result }; }
    catch (e) { if (e.code === "ENOENT" || e instanceof SyntaxError) return false; throw e; }
  }).then(r => r.value);
}
const command = (command, ...args) => call("command", { command, args });
const snapshot = () => command("linyra._itest.snapshot");
let browser;
try {
  await waitFor("extension test host", () => existsSync(join(control, "ready.json")));
  await waitFor("debug port", async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await waitFor("workbench", () => browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes("workbench")));
  const nativeViewport = await page.evaluate(() => ({ width:innerWidth, height:innerHeight, scale:devicePixelRatio }));
  const screen = await page.context().newCDPSession(page);
  // Playwright's default screenshot clips Electron windows at non-integer UI zoom.
  // Capture the native surface without a CSS-pixel clip instead.
  async function capture() {
    const { data } = await screen.send("Page.captureScreenshot", {format:"png",fromSurface:true,captureBeyondViewport:false});
    return Buffer.from(data,"base64");
  }
  console.log("Native maximized viewport:",JSON.stringify(nativeViewport));
  await waitFor("demo repositories", async () => { const s = await snapshot(); return s?.repos.length === 6 && s.readyCount > 0 && s.done && s.rows.length > 10; });
  console.log("Capture host ready; real repositories:", (await snapshot()).repos.map(r => r.name).join(", "));
  const base = { text: "", author: "", mine: false, branch: "", branches: [], repoIds: null, date: "24h", sort: "topo" };
  await command("linyra._itest.send", { type: "filter", filter: base });
  await command("linyra._itest.send", { type: "layout", repoPaneWidth: 180, changesPaneWidth: 620, changesPaneHeight: Math.round(nativeViewport.height*.45), showChanges: true, changesLayout:"sideBySide" });
  await command("notifications.clearAll");
  let state = await snapshot();
  const web = state.repos.find(r=>r.name==="acme-web");
  const target = state.rows.find(r=>r.repoId===web.id && r.subject.startsWith("feat(checkout)"));
  if (!target) throw new Error("Saved-card commit is missing");
  let logView;
  async function select(commit, file) {
    if (logView) {
      const rows = (await snapshot()).rows;
      const index = rows.findIndex(r=>r.repoId===commit.repoId&&r.sha===commit.sha);
      if (index<0) throw new Error("Commit is outside the current recording filter");
      await logView.click(`.row[data-index="${index}"] .subject`);
    } else await command("linyra._itest.send",{type:"select",repoId:commit.repoId,sha:commit.sha});
    await waitFor("selected commit details",async()=> (await snapshot()).changes.presentation?.details[0]?.sha===commit.sha);
    if (file) await command("linyra.openDiff",{repoId:commit.repoId,sha:commit.sha,parent:commit.parents[0],path:file});
    await sleep(450);
  }
  await select(target,"src/checkout/PaymentStep.tsx");
  const sash=page.locator(".monaco-sash.horizontal:not(.disabled)").last();
  const sashBounds=await sash.boundingBox();
  if (sashBounds) { await page.mouse.move(sashBounds.x+sashBounds.width/2,sashBounds.y+2); await page.mouse.down(); await page.mouse.move(sashBounds.x+sashBounds.width/2,Math.round(nativeViewport.height*.54),{steps:16}); await page.mouse.up(); }
  await sleep(500);
  logView = await webviewDriver(browser,"Linyra");
  await select(target);
  for (let i=0;i<3;i++) await logView.key("#detail-splitter","ArrowUp");
  await logView.evaluate("doc.activeElement?.blur(); return true;");
  await page.mouse.move(nativeViewport.width-10,12);
  async function shot(name, region) {
    await sleep(450);
    const buffer=await capture();
    if (region) {
      const {width,height}=await sharp(buffer).metadata();
      const ratio=width/nativeViewport.width;
      const left=Math.max(0,Math.round(region.x*ratio));
      const top=Math.max(0,Math.round(region.y*ratio));
      await sharp(buffer).extract({left,top,width:Math.min(width-left,Math.round(region.width*ratio)),height:Math.min(height-top,Math.round(region.height*ratio))}).png().toFile(join(output,name+".png"));
    } else writeFileSync(join(output,name+".png"),buffer);
    console.log("Captured "+name);
  }
  const panelRect=await page.evaluate(()=>document.getElementById("workbench.parts.panel").getBoundingClientRect().toJSON());
  await shot("screenshot-log");
  if (process.argv.includes("--settings")) {
    await command("workbench.action.openSettings","@ext:whwitpohe.linyra");
    await command("workbench.action.closePanel");
    await page.locator(".settings-editor").waitFor({state:"visible"});
    await sleep(700);
    await shot("feature-settings",{x:Math.max(0,(nativeViewport.width-1420)/2),y:60,width:Math.min(nativeViewport.width,1420),height:Math.min(nativeViewport.height-60,780)});
  } else if (process.argv.includes("--features")) {
    await recordFeatures({browser,page,logView,command,snapshot,select,target,web,waitFor,capture,shot,sharp,output,control,nativeViewport,panelRect});
    await logView.close();
  } else if (process.argv.includes("--prototype")) {
    // Keep this isolated host available for interactive recording-script development.
    await new Promise(resolve => child.on("exit", resolve));
  } else if (!process.argv.includes("--overview")) {
    let frame = 0;
    const frames = join(control,"frames"); mkdirSync(frames,{recursive:true});
    async function hold(count=7) { for(let i=0;i<count;i++){writeFileSync(join(frames,String(frame++).padStart(5,"0")+".png"),await capture());await sleep(80);} }
    await hold(8);
    for (const prefix of ["A","AC","ACME","ACME-","ACME-1","ACME-14","ACME-142"]) { await logView.fill("#search",prefix); await hold(2); }
    await waitFor("cross-repository search",async()=>{const s=await snapshot();return s.filter.text==="ACME-142"&&s.done&&new Set(s.rows.map(r=>r.repoId)).size===4;});
    await hold(10); await shot("screenshot-search");
    state=await snapshot();
    const api=state.repos.find(r=>r.name==="acme-api");
    const apiCommit=state.rows.find(r=>r.repoId===api.id&&r.subject.startsWith("feat(payments)"));
    await select(apiCommit,"src/routes/payments.ts");await hold(12);
    await select(target,"src/checkout/PaymentStep.tsx");await hold(12);
    await logView.fill("#file-filter","PaymentStep");await hold(9);await shot("screenshot-file-search");
    await logView.fill("#file-filter","");await hold(5);
    await logView.fill("#search",""); await waitFor("all recent commits",async()=>{const s=await snapshot();return s.filter.text===""&&s.done&&s.rows.length>15;});
    await select(target);await hold(8);

    // Focused details view: make the text and metadata readable without a tiny full-window inset.
    const head=(await snapshot()).rows.find(r=>r.repoId===web.id&&r.parents.length>1);
    await select(head);
    const detailRect = await logView.evaluate("const pane=doc.getElementById('changes-pane').getBoundingClientRect(); const heading=doc.getElementById('detail-heading').getBoundingClientRect(); return {x:pane.x,y:heading.y,width:pane.width,height:pane.bottom-heading.y};");
    // Webview coordinates are relative to its iframe; add the native panel content origin.
    const iframeRect=await page.locator('iframe.webview.ready').last().boundingBox();
    if (!iframeRect) throw new Error("Recording webview is not visible");
    await shot("screenshot-details",{...detailRect,x:iframeRect.x+detailRect.x,y:iframeRect.y+detailRect.y});
    await select(target);
    await logView.click("#branch");
    await waitFor("branch options",()=>logView.evaluate("return !!doc.querySelector('input[data-branch=main]');"));
    await logView.click('input[data-branch="main"]');
    await logView.click('input[data-branch="feature/saved-cards"]');
    await waitFor("branch union",async()=>{const s=await snapshot();return s.filter.branches?.length===2&&s.done;});
    await shot("screenshot-branches",panelRect);
    await logView.key("#branch-search","Escape");
    await logView.click("#sort");await shot("screenshot-sort",panelRect);
    await logView.key("#sort","Escape");
    await logView.click("#branch");
    await logView.click("#branch-picker .branch-picker-all");
    await logView.key("#branch-search","Escape");
    await waitFor("all branches restored",async()=>{const s=await snapshot();return (s.filter.branches?.length??0)===0&&s.done;});
    // The Repositories tree: a branch name finds every repository that has it, opened on the matches.
    for(let i=0;i<6;i++) await logView.key("#splitter","ArrowRight");
    await logView.fill("#repo-filter","saved");
    await waitFor("branch sidebar",()=>logView.evaluate("const names=[...doc.querySelectorAll('#repo-rows .branch-name')].map(n=>n.textContent);return names.filter(n=>n.includes('saved-cards')).length>=6&&!doc.querySelector('#repo-rows .branch-message');"));
    await shot("screenshot-branch-sidebar",panelRect);
    await logView.fill("#repo-filter","");
    for(let i=0;i<6;i++) await logView.key("#splitter","ArrowLeft");

    await call("history",{file:join(web.root,"src/checkout/PaymentStep.tsx")});
    await waitFor("file history",async()=>Boolean((await snapshot()).history));await shot("screenshot-file-history");
    await logView.click("#history-close");
    await logView.click("#mode-work");
    await waitFor("uncommitted workspace",async()=> (await snapshot()).workKnown && await logView.evaluate("return doc.querySelectorAll('.work-row').length>0;"));
    await logView.evaluate(`[...doc.querySelectorAll('.work-row')].find(n=>n.dataset.repo===${JSON.stringify(web.id)})?.click();return true;`);
    await sleep(350);
    await logView.evaluate("[...doc.querySelectorAll('#file-tree .tree-row')].find(n=>n.textContent.includes('PaymentStep.tsx'))?.click();return true;");
    await shot("screenshot-uncommitted");
    await logView.click("#mode-commits");

    await command("linyra.compareShow");
    await command("linyra._itest.compareView",{left:"origin/release-1.4",right:"main"});
    await waitFor("comparison repositories",async()=>{const s=await command("linyra._itest.compareStore");return !s.reading&&s.rows?.length>0;});
    await command("linyra._itest.compareSelect",web.id);
    const compareView=await webviewDriver(browser,"Repositories");
    await compareView.key("#picker-search","Escape");
    await compareView.click("#compare-layout-horizontal");
    for(let i=0;i<37;i++) await compareView.key("#compare-side-splitter","ArrowRight");
    await compareView.evaluate("doc.activeElement?.blur();return true;");
    await command("linyra._itest.compareReposSend",{type:"sideExpandAll",side:"left"});
    await command("linyra._itest.compareReposSend",{type:"sideExpandAll",side:"right"});
    await sleep(600);await shot("screenshot-compare",panelRect);
    await command("linyra._itest.compareMode","commits");await sleep(650);await shot("screenshot-compare-commits",panelRect);
    await compareView.close();
    await command("linyra.compareHide");await command("linyra.open");
    await command("linyra._itest.send",{type:"filter",filter:base});
    await waitFor("restored log",async()=>{const s=await snapshot();return s.done&&s.rows.some(r=>r.sha===target.sha);});
    await select(target,"src/checkout/PaymentStep.tsx");
    for (const [name,value] of [["light","Default Light Modern"],["high-contrast","Default High Contrast"],["high-contrast-light","Default High Contrast Light"]]) {
      await call("theme",{value});await sleep(700);await shot("screenshot-"+name);
    }
    await call("theme",{value:"Default Dark Modern"});
    const themeNames=["log","light","high-contrast","high-contrast-light"];
    const imageSize=await sharp(join(output,"screenshot-log.png")).metadata();
    const tileHeight=Math.round(imageSize.height/imageSize.width*960);
    const tiles=await Promise.all(themeNames.map(name=>sharp(join(output,"screenshot-"+name+".png")).resize(960,tileHeight).toBuffer()));
    await sharp({create:{width:1920,height:tileHeight*2,channels:3,background:"#202020"}}).composite(tiles.map((input,i)=>({input,left:(i%2)*960,top:Math.floor(i/2)*tileHeight}))).png().toFile(join(output,"screenshot-themes.png"));
    const ffmpeg=process.env.LINYRA_FFMPEG??"ffmpeg";
    const gif=spawnSync(ffmpeg,["-hide_banner","-loglevel","error","-y","-framerate","8","-i",join(frames,"%05d.png"),"-filter_complex","[0:v]scale=1920:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none","-loop","0",join(output,"demo.gif")],{encoding:"utf8"});
    if(gif.status!==0)throw new Error("GIF encoding failed: "+gif.stderr);
    writeFileSync(join(output,"recording.json"),JSON.stringify({version:"1.4.1",width:imageSize.width,height:imageSize.height,locale,panelFraction:0.46,frames:frame,source:"real VS Code with neutral Git repositories",repos:(await snapshot()).repos.map(r=>r.name)},null,2));
    console.log("Recording complete:",frame,"frames");
    await logView.close();
  }
} finally {
  if (!process.argv.includes("--prototype")) { try { await call("finish"); } catch {} }
  if (browser) await browser.close();
}
