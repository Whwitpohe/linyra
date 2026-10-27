import { escapeHtml, language, localizationScript, localize } from "../../i18n";
import type { HtmlOptions } from "../html";

/** Repositories' markup (Linyra Compare tab); the extension host and the browser harness both render it. */
export function renderReposHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(language())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; img-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>${escapeHtml(localize("Repositories"))}</title>
</head>
<body>
<div id="compare-app" class="compare-app">
  <div class="cbar" role="toolbar" aria-label="${escapeHtml(localize("Compare"))}">
    <div class="cbar-pair">
      <button id="branch-left" class="branch-box left" aria-haspopup="dialog" title="${escapeHtml(localize("The branch to merge from"))}"><span class="side-mark" aria-hidden="true">◀</span><span id="name-left" class="branch-name"></span><span class="caret" aria-hidden="true">▾</span></button>
      <button id="swap" class="icon-button" title="${escapeHtml(localize("Swap sides"))}" aria-label="${escapeHtml(localize("Swap sides"))}">⇄</button>
      <button id="branch-right" class="branch-box right" aria-haspopup="dialog" title="${escapeHtml(localize("The branch it goes into"))}"><span class="side-mark" aria-hidden="true">▶</span><span id="name-right" class="branch-name"></span><span class="caret" aria-hidden="true">▾</span></button>
    </div>
    <div class="cbar-show">
      <span class="seg" role="group" aria-label="${escapeHtml(localize("Show"))}"><button id="mode-files" aria-pressed="true">${escapeHtml(localize("Files"))}</button><button id="mode-commits" aria-pressed="false">${escapeHtml(localize("Commits"))}</button></span>
      <button id="refresh" class="icon-button" title="${escapeHtml(localize("Refresh"))}" aria-label="${escapeHtml(localize("Refresh"))}">↻</button>
      <button id="compare-hide-same" class="icon-button" title="${escapeHtml(localize("Hide Files Already on Both"))}" aria-label="${escapeHtml(localize("Hide Files Already on Both"))}" aria-pressed="true">⏷</button>
      <button id="compare-layout-horizontal" class="icon-button" title="${escapeHtml(localize("Side-by-side Layout"))}" aria-label="${escapeHtml(localize("Side-by-side Layout"))}">◫</button>
      <button id="compare-layout-stacked" class="icon-button" title="${escapeHtml(localize("Stacked Layout"))}" aria-label="${escapeHtml(localize("Stacked Layout"))}">⬒</button>
      <button id="compare-toggle-left" class="icon-button" title="${escapeHtml(localize("Show or hide left side"))}" aria-label="${escapeHtml(localize("Show or hide left side"))}" aria-pressed="true">◧</button>
      <button id="compare-toggle-right" class="icon-button" title="${escapeHtml(localize("Show or hide right side"))}" aria-label="${escapeHtml(localize("Show or hide right side"))}" aria-pressed="true">◨</button>
      <button id="compare-close" class="icon-button" title="${escapeHtml(localize("Close Compare"))}" aria-label="${escapeHtml(localize("Close Compare"))}">×</button>
    </div>
  </div>
  <div id="compare-workspace" class="compare-workspace">
  <section id="repos" class="repos" aria-label="${escapeHtml(localize("Repositories"))}">
  <div class="compare-pane-heading"><span>${escapeHtml(localize("Repositories"))}</span></div>
  <div id="summary" class="csummary" aria-live="polite"></div>
  <div id="message" class="cmessage" hidden></div>
  <div id="repo-list" class="repo-list" role="listbox" tabindex="0" aria-label="${escapeHtml(localize("Repositories whose files differ"))}"></div>
  <div id="missing" class="missing" hidden><div class="missing-heading"><button id="missing-toggle" class="compare-twisty" type="button" aria-expanded="false" aria-controls="missing-list" aria-label="${escapeHtml(localize("Show missing repositories"))}">▸</button><span id="missing-title"></span></div><ul id="missing-list" hidden></ul></div>
  </section>
  <div id="compare-repo-splitter" class="compare-splitter" role="separator" aria-orientation="vertical" aria-label="${escapeHtml(localize("Resize comparison repositories"))}" tabindex="0"></div>
  <div id="compare-repo-splitter-vertical" class="compare-splitter horizontal" role="separator" aria-orientation="horizontal" aria-label="${escapeHtml(localize("Resize comparison repositories"))}" tabindex="0" hidden></div>
  <div id="compare-sides" class="compare-sides">
    ${renderSide("left")}
    <div id="compare-side-splitter" class="compare-splitter" role="separator" aria-orientation="vertical" aria-label="${escapeHtml(localize("Resize comparison sides"))}" tabindex="0"></div>
    <div id="compare-side-splitter-vertical" class="compare-splitter horizontal" role="separator" aria-orientation="horizontal" aria-label="${escapeHtml(localize("Resize comparison sides"))}" tabindex="0" hidden></div>
    ${renderSide("right")}
  </div>
  </div>
  <div id="picker" class="picker" role="dialog" aria-label="${escapeHtml(localize("Pick a branch"))}" hidden>
    <input id="picker-search" type="search" placeholder="${escapeHtml(localize("Search branches"))}" aria-label="${escapeHtml(localize("Search branches"))}" autocomplete="off" spellcheck="false">
    <div id="picker-items" class="picker-items" role="listbox" aria-label="${escapeHtml(localize("Branches"))}"></div>
  </div>
</div>
${localizationScript(o.nonce)}
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}

function renderSide(side: "left" | "right"): string {
  const label = localize(side === "left" ? "Left" : "Right");
  return `<section id="compare-${side}" class="compare-side" aria-label="${escapeHtml(label)}">
    <div class="compare-pane-heading"><span id="compare-${side}-description">${escapeHtml(label)}</span><span class="compare-pane-actions">
      <button id="compare-${side}-mode" class="icon-button compare-mode" type="button" title="${escapeHtml(localize("Show Commits"))}" aria-label="${escapeHtml(localize("Show Commits"))}" data-side="${side}">◉</button>
      <button id="compare-${side}-same" class="icon-button compare-same" type="button" title="${escapeHtml(localize("Hide Files Already on Both"))}" aria-label="${escapeHtml(localize("Hide Files Already on Both"))}" data-side="${side}">⏷</button>
      <button id="compare-${side}-expand" class="icon-button" type="button" title="${escapeHtml(localize("Expand All"))}" aria-label="${escapeHtml(localize("Expand All"))}">⊞</button>
      <button id="compare-${side}-collapse" class="icon-button" type="button" title="${escapeHtml(localize("Collapse All"))}" aria-label="${escapeHtml(localize("Collapse All"))}">⊟</button>
    </span></div>
    <div id="compare-${side}-message" class="cmessage" role="status" hidden></div>
    <div id="compare-${side}-tree" class="compare-tree" role="tree" tabindex="0" aria-label="${escapeHtml(label)}"></div>
  </section>`;
}
