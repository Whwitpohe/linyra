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
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; img-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>Polylog</title>
</head>
<body>
<div id="app" class="app">
  <aside id="repo-pane" class="repo-pane" aria-label="Repositories">
    <div class="repo-search"><input id="repo-filter" class="repo-filter" type="search" placeholder="Filter repositories" aria-label="Filter repositories" autocomplete="off" spellcheck="false"></div>
    <div id="repo-rows" class="repo-rows" role="listbox" aria-multiselectable="true" aria-label="Repositories" tabindex="0"></div>
  </aside>
  <div id="splitter" class="splitter" role="separator" aria-orientation="vertical" aria-label="Resize the repositories pane" tabindex="0"></div>
  <div class="log">
    <div id="modebar" class="modebar" role="toolbar" aria-label="Log mode" hidden>
      <button id="mode-all" class="mode" type="button">All commits</button>
      <span id="mode-history" class="mode active" aria-current="true"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 5v3.2l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg><span>File history:</span><span id="history-path" class="history-path"></span>
        <button id="history-close" class="icon-button mode-close" type="button" aria-label="Close file history" title="Back to all commits">×</button>
      </span>
    </div>
    <div id="logswitch" class="logswitch">
      <div class="switch" role="tablist" aria-label="The Log shows">
        <button id="mode-commits" class="switch-tab" role="tab" type="button" aria-selected="true" tabindex="0">Commits</button>
        <button id="mode-work" class="switch-tab" role="tab" type="button" aria-selected="false" tabindex="-1">Uncommitted<span id="work-count" class="work-count" hidden></span></button>
      </div>
      <span id="work-totals" class="work-totals"></span>
    </div>
    <form id="filters" class="filters" role="search" aria-label="Filter commits">
      <input id="search" class="search" type="search" placeholder="Search messages" aria-label="Search commit messages" autocomplete="off" spellcheck="false">
      <span id="author-field" class="author-field">
        <span id="author-chips" class="author-chips" role="list" aria-label="Authors"></span>
        <input id="author" class="author-filter" type="search" placeholder="Author" aria-label="Filter by author name or email. Enter adds another author" autocomplete="off" spellcheck="false">
        <button id="me" class="input-toggle" type="button" title="Only my commits" hidden>Me</button>
      </span>
      <input id="path" class="path-filter" type="search" placeholder="Path or glob" aria-label="Only commits touching this path in each repository: a file, a folder or a glob like **/*.sql" autocomplete="off" spellcheck="false">
      <input id="branch" class="branch-filter" type="search" placeholder="Current branch" aria-label="Branch: shown in every repository that has it; the others use their current branch" autocomplete="off" spellcheck="false">
      <select id="date" aria-label="Date range">
        <option value="24h">Last 24 hours</option>
        <option value="7d">Last 7 days</option>
        <option value="30d">Last 30 days</option>
        <option value="all">All time</option>
        <option value="custom">Custom range</option>
      </select>
      <span id="custom-range" class="custom-range" hidden>
        <input id="from" type="date" aria-label="From date">
        <span aria-hidden="true">–</span>
        <input id="to" type="date" aria-label="To date">
      </span>
      <button id="refresh" class="icon-button" type="button" aria-label="Refresh" title="Refresh">${REFRESH_ICON}</button>
    </form>
    <div id="notices" class="notices"></div>
    <main class="main">
      <section class="list-pane" aria-label="Commits">
        <div id="list" class="list" role="grid" aria-label="Commits" aria-rowcount="0" tabindex="0">
          <div id="rows" class="rows" role="rowgroup"></div>
        </div>
        <div id="worklist" class="worklist" role="listbox" aria-label="Repositories with uncommitted changes" tabindex="0" hidden></div>
        <div id="empty" class="empty" hidden></div>
      </section>
    </main>
    <footer class="footer">
      <button id="more" class="secondary" type="button" hidden>Load More</button>
      <span class="note" title="Commits in different repositories share no history, so they are merged by committer date. A rebase or a skewed clock can place a commit out of order.">Newest first by commit date</span>
      <span id="branch-use" class="note"></span>
      <span id="limit" class="note" role="status"></span>
      <span id="count" class="count" aria-live="polite"></span>
    </footer>
  </div>
</div>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>
`;
}
