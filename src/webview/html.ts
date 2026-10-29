import { escapeHtml, language, localizationScript, localize } from "../i18n";
import { renderChangesBody } from "./changes/html";
import { codicon } from "./codicons";
export interface HtmlOptions {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
}



/** The one markup source for both the extension host and the browser harness. */
export function renderHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(language())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; img-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>Linyra</title>
</head>
<body>
<div id="workspace" class="workspace">
<div id="app" class="app">
  <aside id="repo-pane" class="repo-pane" aria-label="${escapeHtml(localize("Repositories"))}">
    <div class="repo-search">
      <input id="repo-filter" class="repo-filter" type="search" placeholder="${escapeHtml(localize("Find repo or branch"))}" aria-label="${escapeHtml(localize("Search repositories or branches"))}" autocomplete="off" spellcheck="false">
      <button id="repo-expand-all" class="icon-button" type="button" title="${escapeHtml(localize("Expand All"))}" aria-label="${escapeHtml(localize("Expand All Repositories"))}">${codicon("expand-all")}</button>
      <button id="repo-collapse-all" class="icon-button" type="button" title="${escapeHtml(localize("Collapse All"))}" aria-label="${escapeHtml(localize("Collapse All Repositories"))}">${codicon("collapse-all")}</button>
    </div>
    <div id="repo-rows" class="repo-rows" role="tree" aria-multiselectable="true" aria-label="${escapeHtml(localize("Repositories and branches"))}" tabindex="0"></div>
  </aside>
  <div id="splitter" class="splitter" role="separator" aria-orientation="vertical" aria-label="${escapeHtml(localize("Resize the repositories pane"))}" tabindex="0"></div>
  <div class="log">
    <div id="modebar" class="modebar" role="toolbar" aria-label="${escapeHtml(localize("Log mode"))}" hidden>
      <button id="mode-all" class="mode" type="button">${escapeHtml(localize("All commits"))}</button>
      <span id="mode-history" class="mode active" aria-current="true">${codicon("history")}<span>${escapeHtml(localize("File history:"))}</span><span id="history-path" class="history-path"></span>
        <button id="history-close" class="icon-button mode-close" type="button" aria-label="${escapeHtml(localize("Close file history"))}" title="${escapeHtml(localize("Back to all commits"))}">${codicon("close")}</button>
      </span>
    </div>
    <!-- One header row, as the JetBrains Log keeps it: the switch, the filters, then the actions.
         It wraps onto more rows only when the Log is narrow. -->
    <div id="log-header" class="log-header">
      <div class="switch" role="tablist" aria-label="${escapeHtml(localize("The Log shows"))}">
        <button id="mode-commits" class="switch-tab" role="tab" type="button" aria-selected="true" tabindex="0">${escapeHtml(localize("Commits"))}</button>
        <button id="mode-work" class="switch-tab" role="tab" type="button" aria-selected="false" tabindex="-1">${escapeHtml(localize("Uncommitted"))}<span id="work-count" class="work-count" hidden></span></button>
      </div>
      <span id="work-totals" class="work-totals"></span>
      <form id="filters" class="filters" role="search" aria-label="${escapeHtml(localize("Filter commits"))}">
        <span id="search-field" class="search-field">
          <button id="search-ai" class="input-toggle search-ai" type="button" aria-pressed="false" aria-disabled="true" aria-label="${escapeHtml(localize("Search in natural language with Linyra AI"))}">${codicon("sparkle")}</button>
          <input id="search" class="search" type="search" placeholder="${escapeHtml(localize("Search commits, e.g. fix author:@me file:*.ts"))}" aria-label="${escapeHtml(localize("Search commits: words, a hash, or operators such as author: and file:"))}" aria-describedby="search-errors hash-search-note" autocomplete="off" spellcheck="false">
          <span class="search-toggles">
            <button id="match-case" class="input-toggle search-toggle" type="button" aria-pressed="false" title="${escapeHtml(localize("Match Case"))}" aria-label="${escapeHtml(localize("Match Case"))}">${codicon("case-sensitive")}</button>
            <button id="whole-word" class="input-toggle search-toggle" type="button" aria-pressed="false" title="${escapeHtml(localize("Match Whole Word"))}" aria-label="${escapeHtml(localize("Match Whole Word"))}">${codicon("whole-word")}</button>
            <button id="use-regex" class="input-toggle search-toggle" type="button" aria-pressed="false" title="${escapeHtml(localize("Use Regular Expression"))}" aria-label="${escapeHtml(localize("Use Regular Expression"))}">${codicon("regex")}</button>
            <button id="match-all" class="input-toggle search-toggle" type="button" aria-pressed="false" title="${escapeHtml(localize("Match All Words"))}" aria-label="${escapeHtml(localize("Match All Words"))}">${codicon("check-all")}</button>
          </span>
          <span id="search-errors" class="search-errors" hidden></span>
        </span>
        <span id="author-field" class="author-field">
          <button id="author" class="branch-filter author-filter" type="button" aria-expanded="false" aria-controls="author-picker" aria-haspopup="dialog" aria-label="${escapeHtml(localize("Filter authors"))}">${escapeHtml(localize("All authors"))}</button>
          <button id="me" class="input-toggle" type="button" title="${escapeHtml(localize("Only my commits"))}" hidden>${escapeHtml(localize("Me"))}</button>
        </span>
        <input id="path" class="path-filter" type="search" placeholder="${escapeHtml(localize("Path or glob"))}" aria-label="${escapeHtml(localize("Only commits touching this path in each repository: a file, a folder or a glob like **/*.sql"))}" autocomplete="off" spellcheck="false">
        <button id="branch" class="branch-filter" type="button" aria-expanded="false" aria-controls="branch-picker" aria-haspopup="dialog" aria-label="${escapeHtml(localize("Filter branches"))}">${escapeHtml(localize("All branches"))}</button>
        <span id="date-field" class="select-field">
          <select id="date" aria-label="${escapeHtml(localize("Date range"))}">
            <option value="24h">${escapeHtml(localize("Last 24 hours"))}</option>
            <option value="7d">${escapeHtml(localize("Last 7 days"))}</option>
            <option value="30d">${escapeHtml(localize("Last 30 days"))}</option>
            <option value="all">${escapeHtml(localize("All time"))}</option>
            <option value="custom">${escapeHtml(localize("Custom range"))}</option>
          </select>
          ${codicon("chevron-down", "chevron")}
        </span>
        <span id="custom-range" class="custom-range" hidden>
          <input id="from" type="date" aria-label="${escapeHtml(localize("From date"))}">
          <span aria-hidden="true">–</span>
          <input id="to" type="date" aria-label="${escapeHtml(localize("To date"))}">
        </span>
        <button id="sort" class="icon-button" type="button" aria-label="${escapeHtml(localize("Sort"))}" aria-haspopup="menu" aria-expanded="false">${codicon("sort-precedence")}</button>
        <button id="refresh" class="icon-button" type="button" aria-label="${escapeHtml(localize("Refresh"))}" title="${escapeHtml(localize("Refresh"))}">${codicon("refresh")}</button>
      </form>
      <span class="header-actions" role="toolbar" aria-label="${escapeHtml(localize("Log actions"))}">
        <button id="toggle-changes" class="icon-button" type="button" title="${escapeHtml(localize("Show or hide changed files"))}" aria-label="${escapeHtml(localize("Show or hide changed files"))}" aria-pressed="true">${codicon("diff-multiple")}</button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <button id="toolbar-repos" class="icon-button" type="button" aria-label="${escapeHtml(localize("Group by Repository"))}"></button>
        <button id="toolbar-compare" class="icon-button" type="button" aria-label="${escapeHtml(localize("Compare Branches"))}"></button>
        <button id="toolbar-fetch" class="icon-button" type="button" aria-label="${escapeHtml(localize("Fetch All Repositories"))}"></button>
        <button id="toolbar-update" class="icon-button" type="button" aria-label="${escapeHtml(localize("Update Project…"))}" title="${escapeHtml(localize("Update Project…"))}"></button>
        <button id="toolbar-push" class="icon-button" type="button" aria-label="${escapeHtml(localize("Push…"))}" title="${escapeHtml(localize("Push…"))}"></button>
        <button id="toolbar-more" class="icon-button" type="button" aria-haspopup="menu" aria-expanded="false" title="${escapeHtml(localize("More Log Actions"))}" aria-label="${escapeHtml(localize("More Log Actions"))}">${codicon("ellipsis")}</button>
      </span>
    </div>
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
