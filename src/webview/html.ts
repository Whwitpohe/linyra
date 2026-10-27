import { escapeHtml, language, localizationScript, localize } from "../i18n";
import { renderChangesBody } from "./changes/html";
export interface HtmlOptions {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
}

// Inline SVG, not a codicon: the codicon font would be a bundled webfont.
const REFRESH_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path fill="none" stroke="currentColor" stroke-width="1.3" d="M13 8a5 5 0 1 1-1.46-3.54"/>' +
  '<path fill="currentColor" d="M13.5 2v4h-4z"/></svg>';

/** The one markup source for both the extension host and the browser harness. */
export function renderHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(language())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; img-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>Polylog</title>
</head>
<body>
<div id="workspace" class="workspace">
<div id="app" class="app">
  <aside id="repo-pane" class="repo-pane" aria-label="${escapeHtml(localize("Repositories"))}">
    <div class="repo-search">
      <div class="sidebar-modes" role="tablist" aria-label="${escapeHtml(localize("Sidebar mode"))}"><button id="sidebar-repos" type="button" role="tab" aria-selected="true">${escapeHtml(localize("Repositories"))}</button><button id="sidebar-branches" type="button" role="tab" aria-selected="false" tabindex="-1">${escapeHtml(localize("Branches"))}</button><button id="branch-refresh" class="icon-button" type="button" title="${escapeHtml(localize("Refresh branches"))}" aria-label="${escapeHtml(localize("Refresh branches"))}" hidden>↻</button></div>
      <input id="repo-filter" class="repo-filter" type="search" placeholder="${escapeHtml(localize("Filter repositories"))}" aria-label="${escapeHtml(localize("Filter repositories"))}" autocomplete="off" spellcheck="false">
    </div>
    <div id="repo-rows" class="repo-rows" role="listbox" aria-multiselectable="true" aria-label="${escapeHtml(localize("Repositories"))}" tabindex="0"></div>
    <div id="branch-tree" class="branch-tree" role="tree" aria-label="${escapeHtml(localize("Branches"))}" tabindex="0" hidden></div>
  </aside>
  <div id="splitter" class="splitter" role="separator" aria-orientation="vertical" aria-label="${escapeHtml(localize("Resize the repositories pane"))}" tabindex="0"></div>
  <div class="log">
    <div class="log-toolbar" role="toolbar" aria-label="${escapeHtml(localize("Log actions"))}"><span class="log-toolbar-label">${escapeHtml(localize("Log"))}</span><span class="log-toolbar-actions">
      <button id="toolbar-repos" class="icon-button" type="button" aria-label="${escapeHtml(localize("Group by Repository"))}"></button>
      <button id="toolbar-compare" class="icon-button" type="button" aria-label="${escapeHtml(localize("Compare Branches"))}"></button>
      <button id="toolbar-uncommitted" class="icon-button" type="button" aria-label="${escapeHtml(localize("Show Uncommitted View"))}"></button>
      <button id="toolbar-fetch" class="icon-button" type="button" aria-label="${escapeHtml(localize("Fetch All Repositories"))}"></button>
      <span class="toolbar-divider" aria-hidden="true"></span>
      <button id="layout-sideBySide" class="icon-button" type="button" title="${escapeHtml(localize("Side-by-side Layout"))}" aria-label="${escapeHtml(localize("Side-by-side Layout"))}" aria-pressed="false"></button>
      <button id="layout-stacked" class="icon-button" type="button" title="${escapeHtml(localize("Stacked Layout"))}" aria-label="${escapeHtml(localize("Stacked Layout"))}" aria-pressed="false"></button>
      <button id="toolbar-more" class="icon-button" type="button" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(localize("More Log Actions"))}" aria-label="${escapeHtml(localize("More Log Actions"))}">⋯</button>
    </span></div>
    <div id="modebar" class="modebar" role="toolbar" aria-label="${escapeHtml(localize("Log mode"))}" hidden>
      <button id="mode-all" class="mode" type="button">${escapeHtml(localize("All commits"))}</button>
      <span id="mode-history" class="mode active" aria-current="true"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 5v3.2l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg><span>${escapeHtml(localize("File history:"))}</span><span id="history-path" class="history-path"></span>
        <button id="history-close" class="icon-button mode-close" type="button" aria-label="${escapeHtml(localize("Close file history"))}" title="${escapeHtml(localize("Back to all commits"))}">×</button>
      </span>
    </div>
    <div id="logswitch" class="logswitch">
      <div class="switch" role="tablist" aria-label="${escapeHtml(localize("The Log shows"))}">
        <button id="mode-commits" class="switch-tab" role="tab" type="button" aria-selected="true" tabindex="0">${escapeHtml(localize("Commits"))}</button>
        <button id="mode-work" class="switch-tab" role="tab" type="button" aria-selected="false" tabindex="-1">${escapeHtml(localize("Uncommitted"))}<span id="work-count" class="work-count" hidden></span></button>
      </div>
      <span id="work-totals" class="work-totals"></span>
      <span class="pane-controls">
        <button id="toggle-changes" class="icon-button" type="button" title="${escapeHtml(localize("Show or hide changed files"))}" aria-label="${escapeHtml(localize("Show or hide changed files"))}" aria-pressed="true">◧</button>
      <span id="graph-controls" class="graph-controls" role="group" aria-label="${escapeHtml(localize("Graph folding"))}">
        <button id="graph-collapse" class="icon-button" type="button" title="${escapeHtml(localize("Collapse Linear Branches"))}" aria-label="${escapeHtml(localize("Collapse Linear Branches"))}" disabled>⊟</button>
        <button id="graph-expand" class="icon-button" type="button" title="${escapeHtml(localize("Expand Linear Branches"))}" aria-label="${escapeHtml(localize("Expand Linear Branches"))}" disabled>⊞</button>
      </span>
      </span>
    </div>
    <form id="filters" class="filters" role="search" aria-label="${escapeHtml(localize("Filter commits"))}">
      <input id="search" class="search" type="search" placeholder="${escapeHtml(localize("Search messages or hash"))}" aria-label="${escapeHtml(localize("Search commit messages or hash"))}" aria-describedby="hash-search-note" autocomplete="off" spellcheck="false">
      <span id="author-field" class="author-field">
        <button id="author" class="branch-filter author-filter" type="button" aria-expanded="false" aria-controls="author-picker" aria-haspopup="dialog" aria-label="${escapeHtml(localize("Filter authors"))}">${escapeHtml(localize("All authors"))}</button>
        <button id="me" class="input-toggle" type="button" title="${escapeHtml(localize("Only my commits"))}" hidden>${escapeHtml(localize("Me"))}</button>
      </span>
      <input id="path" class="path-filter" type="search" placeholder="${escapeHtml(localize("Path or glob"))}" aria-label="${escapeHtml(localize("Only commits touching this path in each repository: a file, a folder or a glob like **/*.sql"))}" autocomplete="off" spellcheck="false">
      <button id="branch" class="branch-filter" type="button" aria-expanded="false" aria-controls="branch-picker" aria-haspopup="dialog" aria-label="${escapeHtml(localize("Filter branches"))}">${escapeHtml(localize("All branches"))}</button>
      <select id="date" aria-label="${escapeHtml(localize("Date range"))}">
        <option value="24h">${escapeHtml(localize("Last 24 hours"))}</option>
        <option value="7d">${escapeHtml(localize("Last 7 days"))}</option>
        <option value="30d">${escapeHtml(localize("Last 30 days"))}</option>
        <option value="all">${escapeHtml(localize("All time"))}</option>
        <option value="custom">${escapeHtml(localize("Custom range"))}</option>
      </select>
      <span id="custom-range" class="custom-range" hidden>
        <input id="from" type="date" aria-label="${escapeHtml(localize("From date"))}">
        <span aria-hidden="true">–</span>
        <input id="to" type="date" aria-label="${escapeHtml(localize("To date"))}">
      </span>
      <button id="sort" class="icon-button" type="button" aria-label="${escapeHtml(localize("Sort"))}" aria-haspopup="menu" aria-expanded="false"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2v12m-2-2 2 2 2-2M9 3h5M9 7h4M9 11h2" fill="none" stroke="currentColor" stroke-width="1.2"/></svg></button>
      <button id="refresh" class="icon-button" type="button" aria-label="${escapeHtml(localize("Refresh"))}" title="${escapeHtml(localize("Refresh"))}">${REFRESH_ICON}</button>
    </form>
    <div id="hash-search-note" class="hash-search-note" role="status" hidden>${escapeHtml(localize("Hash lookup: searching selected repositories. Other filters are temporarily ignored."))}</div>
    <div id="notices" class="notices"></div>
    <main class="main">
      <section class="list-pane" aria-label="${escapeHtml(localize("Commits"))}">
        <div id="list" class="list" role="grid" aria-label="${escapeHtml(localize("Commits"))}" aria-rowcount="0" tabindex="0">
          <div id="rows" class="rows" role="rowgroup"></div>
        </div>
        <div id="worklist" class="worklist" role="listbox" aria-label="${escapeHtml(localize("Repositories with uncommitted changes"))}" tabindex="0" hidden></div>
        <div id="empty" class="empty" hidden></div>
      </section>
    </main>
    <footer class="footer">
      <button id="more" class="secondary" type="button" hidden>${escapeHtml(localize("Load More"))}</button>
      <span id="order-note" class="note" title="${escapeHtml(localize("Commits in different repositories share no history, so they are merged by committer date. A rebase or a skewed clock can place a commit out of order."))}">${escapeHtml(localize("Newest first by commit date"))}</span>
      <span id="branch-use" class="note"></span>
      <span id="limit" class="note" role="status"></span>
      <span id="graph-fold-count" class="note" role="status" hidden></span>
      <span id="count" class="count" aria-live="polite"></span>
    </footer>
  </div>
</div>
<div id="changes-splitter" class="splitter changes-splitter" role="separator" aria-orientation="vertical" aria-label="${escapeHtml(localize("Resize changed files"))}" tabindex="0"></div>
<div id="changes-splitter-vertical" class="splitter changes-splitter-vertical" role="separator" aria-orientation="horizontal" aria-label="${escapeHtml(localize("Resize changed files"))}" tabindex="0" hidden></div>
<section id="changes-pane" aria-label="${escapeHtml(localize("Changed files"))}">${renderChangesBody()}</section>
</div>
${localizationScript(o.nonce)}
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>
`;
}
