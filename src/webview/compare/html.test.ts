import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { renderReposHtml } from "./html";

const html = renderReposHtml({ cspSource: "vscode-resource:", nonce: "safe-compare", scriptUri: "compare.js", styleUri: "compare.css" });
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
assert.deepStrictEqual(manifest.contributes.views["linyra-compare"].map((view: { id: string }) => view.id), ["linyra.compare"], "one native view removes all three whole-row collapse targets");
for (const id of ["branch-left", "branch-right", "swap", "mode-files", "mode-commits", "refresh", "repo-list", "picker", "picker-search", "picker-items", "compare-hide-same", "compare-close", "missing-toggle"]) {
  assert.ok(html.includes(`id="${id}"`), `comparison feature is still reachable: ${id}`);
}
for (const side of ["left", "right"]) for (const suffix of ["tree", "message", "description", "mode", "same", "tree-toggle"]) {
  assert.ok(html.includes(`id="compare-${side}-${suffix}"`), `side action is retained: ${side}/${suffix}`);
}
assert.ok(!html.includes("<summary"), "missing-branch disclosure uses an arrow button, not a whole-row summary");
const menus = manifest.contributes.menus["webview/context"] as { command: string; when: string }[];
for (const command of ["linyra.commitCopySha", "linyra.commitCopyMessage", "linyra.commitOpenOnRemote", "linyra.openWorkingFile", "linyra.fileHistory", "linyra.copyFilePath", "linyra.copyRelativePath", "linyra.compareOpenSinceSplit"]) {
  assert.ok(menus.some((item) => item.command === command && item.when.includes("compareSideRow")), `original side context action migrated: ${command}`);
}
assert.ok(html.includes("script-src 'nonce-safe-compare'"));
assert.ok(!/\sstyle=/.test(html));
console.log("ok - unified comparison retains branch controls, both display modes, side toolbars and every context action without whole-row collapse headers");
