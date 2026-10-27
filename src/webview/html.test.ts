import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { renderHtml } from "./html";

const html = renderHtml({ cspSource: "vscode-resource:", nonce: "n0nce", scriptUri: "vscode-resource:/out/webview.js", styleUri: "vscode-resource:/out/webview.css" });

{
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.deepStrictEqual(manifest.contributes.views.polylog.map((view: { id: string }) => view.id), ["polylog.log"], "one native view removes the collapsible Log section header");
  assert.ok(html.includes('id="workspace"') && html.includes('id="changes-pane"') && html.includes('id="changes-splitter"'));
  const toggle = /<button id="detail-toggle"[\s\S]*?<\/button>/.exec(html)![0];
  assert.ok(!toggle.includes(">Commit details<"), "only the detail arrow is inside the fold button");
  assert.ok(html.includes('id="toggle-changes"'), "changed files has an explicit visibility control");
  console.log("ok - one native surface contains both panes; section labels are outside collapse buttons");
}

{
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? "";
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("script-src 'nonce-n0nce'"));
  assert.ok(csp.includes("style-src vscode-resource:"));
  assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
  assert.ok(html.includes(`<script nonce="n0nce" src="vscode-resource:/out/webview.js"></script>`));
  console.log("ok - strict CSP: nonce'd script, no unsafe-inline");
}
{
  assert.ok(!/\sstyle="/.test(html), "no inline style attributes (CSP forbids them)");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(html), "no literal colors");
  console.log("ok - no inline styles or literal colors in the shell");
}
{
  for (const id of ["app", "repo-pane", "repo-filter", "repo-rows", "splitter", "modebar", "mode-all", "history-path", "history-close", "filters", "search", "author", "me", "path", "branch", "branch-use", "date", "custom-range", "from", "to", "refresh", "notices", "list", "rows", "empty", "more", "count"]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  console.log("ok - every element main.ts looks up exists");
}
{
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    const text = m[2].replace(/<[^>]+>/g, "").trim();
    assert.ok(text || /aria-label="[^"]+"/.test(m[1]), `button without an accessible name: ${m[0].slice(0, 80)}`);
  }
  assert.ok(/id="list"[^>]*role="grid"/.test(html) && /id="list"[^>]*tabindex="0"/.test(html));
  console.log("ok - every button has an accessible name; the list is a focusable grid");
}
