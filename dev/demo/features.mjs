// Focused recordings of Linyra additions, using ordinary controls in the real webviews.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { webviewDriver } from "./webviewDriver.mjs";

export async function recordFeatures(r) {
  const { browser, page, logView, command, snapshot, select, target, web, waitFor, capture, shot, sharp, output, control, nativeViewport, panelRect } = r;
  async function region(selector) {
    const rect = await logView.evaluate(`return doc.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON();`);
    const frame = await page.locator("iframe.webview.ready").last().boundingBox();
    if (!frame) throw new Error("Feature recording needs a visible webview");
    return { ...rect, x:frame.x+rect.x, y:frame.y+rect.y };
  }
  const logRegion = await region("#app");
  const changesRegion = await region("#changes-pane");
  const manifest = [];
  async function resize(view, selector, dx, dy, hold) {
    const rect=await view.evaluate(`return doc.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON();`);
    const frame=await page.locator("iframe.webview.ready").last().boundingBox();
    const x=frame.x+rect.x+rect.width/2, y=frame.y+rect.y+rect.height/2;
    await page.mouse.move(x,y); await page.mouse.down();
    for(let step=1;step<=6;step++) {
      await page.mouse.move(x+dx*step/6,y+dy*step/6);
      if(hold)await hold(1/6);
    }
    await page.mouse.up();
  }
  async function clip(name, rect, action) {
    const frames = join(control,name); mkdirSync(frames,{recursive:true});
    let count = 0;
    async function hold(seconds=1) {
      for (let i=0;i<Math.ceil(seconds*6);i++) {
        const buffer = await capture();
        const {width,height}=await sharp(buffer).metadata();
        const ratio=width/nativeViewport.width;
        const left=Math.max(0,Math.round(rect.x*ratio)), top=Math.max(0,Math.round(rect.y*ratio));
        await sharp(buffer).extract({left,top,width:Math.min(width-left,Math.round(rect.width*ratio)),height:Math.min(height-top,Math.round(rect.height*ratio))}).png().toFile(join(frames,String(count++).padStart(5,"0")+".png"));
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }
    await action(hold);
    const result=spawnSync(process.env.LINYRA_FFMPEG??"ffmpeg",["-hide_banner","-loglevel","error","-y","-framerate","6","-i",join(frames,"%05d.png"),"-filter_complex","[0:v]scale='min(1600,iw)':-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=none","-loop","0",join(output,name+".gif")],{encoding:"utf8"});
    if(result.status!==0)throw new Error("Feature GIF encoding failed: "+result.stderr);
    manifest.push({name,frames:count,source:"real native VS Code surface",region:rect});
    console.log("Recorded "+name+": "+count+" frames");
  }

  await clip("feature-branches",logRegion,async hold=>{
    await hold(1.5);
    await logView.click("#branch");
    await waitFor("branch checklist",()=>logView.evaluate("return !!doc.querySelector('input[data-branch=main]');"));
    await logView.click('input[data-branch="main"]');
    await logView.click('input[data-branch="feature/saved-cards"]');
    await waitFor("selected branch union",async()=>{const s=await snapshot();return s.filter.branches?.length===2&&s.done;});
    await hold(2); await shot("feature-branches",logRegion);
    await logView.key("#branch-search","Escape");
    await logView.click("#sort"); await hold(1);
    await logView.click(".sort-choice:nth-of-type(1)");
    await waitFor("date sort",async()=>{const s=await snapshot();return s.filter.sort!=="topo"&&s.done;});
    await hold(1.5);
    await logView.click("#sort"); await logView.click(".sort-choice:nth-of-type(2)");
    await waitFor("topology sort",async()=>{const s=await snapshot();return s.filter.sort==="topo"&&s.done;});
    await hold(1.5);
    // Graph folding lives in the ⋯ menu.
    await logView.click("#toolbar-more"); await logView.evaluate("[...doc.querySelectorAll('#toolbar-menu button')].find((b)=>b.textContent==='Collapse Linear Branches').click();return true;");
    await waitFor("folded paths",()=>logView.evaluate("return !!doc.querySelector('.folded-row');"));
    await hold(2); await shot("feature-folding",logRegion);
    await logView.click("#toolbar-more"); await logView.evaluate("[...doc.querySelectorAll('#toolbar-menu button')].find((b)=>b.textContent==='Expand Linear Branches').click();return true;"); await hold(1.5);
    await logView.click("#author");
    await waitFor("author checklist",()=>logView.evaluate("return doc.querySelectorAll('#author-picker input[data-author]').length>=2;"));
    await logView.evaluate("doc.querySelectorAll('#author-picker input[data-author]')[0].click();return true;");
    await logView.evaluate("doc.querySelectorAll('#author-picker input[data-author]')[1].click();return true;");
    await hold(2); await shot("feature-authors",logRegion);
    await logView.click("#author-picker .branch-picker-all");
    await logView.key("#author-search","Escape"); await hold(1);
  });
  await logView.click("#branch"); await logView.click("#branch-picker .branch-picker-all"); await logView.key("#branch-search","Escape");
  await waitFor("all branch history",async()=>{const s=await snapshot();return !s.filter.branches?.length&&s.done;});
  const head=(await snapshot()).rows.find(commit=>commit.repoId===web.id&&commit.parents.length>1);
  await clip("feature-commit-review",changesRegion,async hold=>{
    await select(head);
    for(let i=0;i<4;i++)await logView.key("#detail-splitter","ArrowUp");
    await logView.evaluate("doc.activeElement?.blur();return true;");
    await hold(2); await shot("feature-commit-review",changesRegion);
    await logView.click(".branches-toggle"); await hold(1);
    await logView.click(".branches-toggle"); await hold(1);
    await logView.click("#detail-toggle"); await hold(1);
    await logView.click("#detail-toggle"); await hold(1);
    await resize(logView,"#detail-splitter",0,64,hold);
    await hold(1);
    await resize(logView,"#detail-splitter",0,-64,hold);
    await hold(1);
    await select(target); await hold(1.5);
    await logView.fill("#file-filter","PaymentStep"); await hold(1.5);
    await logView.fill("#file-filter",""); await hold(1);
  });

  const rootSha=execFileSync("git",["rev-list","--max-parents=0","HEAD"],{cwd:web.root,encoding:"utf8",windowsHide:true}).trim().split(/\s+/)[0];
  const hashRegion={...logRegion,height:Math.min(300,logRegion.height)};
  await clip("feature-hash-lookup",hashRegion,async hold=>{
    await hold(1);
    await logView.fill("#search",rootSha.slice(0,7));
    await waitFor("old commit hash match",async()=>{const s=await snapshot();return s.done&&s.rows.some(commit=>commit.repoId===web.id&&commit.sha===rootSha);});
    await hold(2); await shot("feature-hash-lookup",hashRegion);
    await logView.fill("#search","");
    await waitFor("filters restored after hash",async()=>{const s=await snapshot();return s.filter.text===""&&s.done&&s.rows.length>10;});
    await hold(1.5);
  });

  await command("linyra.compareShow");
  await command("linyra._itest.compareView",{left:"origin/release-1.4",right:"main"});
  await waitFor("comparison ready",async()=>{const s=await command("linyra._itest.compareStore");return !s.reading&&s.rows?.length>0;});
  await command("linyra._itest.compareSelect",web.id);
  const compare=await webviewDriver(browser,"Repositories");
  await compare.key("#picker-search","Escape"); await compare.click("#compare-layout-horizontal");
  await compare.click("#compare-left-expand");await compare.click("#compare-right-expand");
  await waitFor("both comparison trees",()=>compare.evaluate("return doc.getElementById('compare-left-tree').textContent.includes('retry.ts')&&doc.getElementById('compare-right-tree').textContent.includes('PaymentStep.tsx');"));
  const delta=await compare.evaluate("return (doc.getElementById('compare-sides').clientWidth-6)/2-doc.getElementById('compare-left').getBoundingClientRect().width;");
  await resize(compare,"#compare-side-splitter",delta,0);
  const balanced=await compare.evaluate("return Math.abs(doc.getElementById('compare-left').getBoundingClientRect().width-doc.getElementById('compare-right').getBoundingClientRect().width)<40;");
  if(!balanced)throw new Error("Comparison recording needs balanced side widths");
  await compare.evaluate("doc.activeElement?.blur();return true;");
  await clip("feature-compare",panelRect,async hold=>{
    await hold(2);await shot("feature-compare",panelRect);
    await compare.click("#mode-commits");
    await waitFor("comparison commit mode",async()=> (await command("linyra._itest.compare")).mode==="commits");
    await compare.click("#compare-right-expand");await hold(2);
    await compare.click("#mode-files");await hold(1.5);
    const api=(await snapshot()).repos.find(repo=>repo.name==="acme-api");
    await compare.evaluate(`[...doc.querySelectorAll('.crepo')].find(node=>node.dataset.repo===${JSON.stringify(api.id)})?.click();return true;`);
    await hold(1.5);
    await compare.click("#swap");await hold(1.5);
    await resize(compare,"#compare-side-splitter",-100,0,hold);
    await compare.evaluate("doc.activeElement?.blur();return true;");await hold(1.5);
  });
  await compare.close();
  writeFileSync(join(output,"features.json"),JSON.stringify({version:"1.4.2",clips:manifest},null,2));
}
