import { escapeHtml, language, localizationScript, localize } from "../../i18n";
import { codicon, type Codicon } from "../codicons";
import type { HtmlOptions } from "../html";

/** A tab: its icon and name (a narrow tab shows the icon alone, so the name is its label too). */
function tab(id: string, icon: Codicon, label: string): string {
  return `<button id="tab-${id}" class="insights-tab" role="tab" type="button" data-tab="${id}" aria-controls="panel-${id}" aria-selected="false" tabindex="-1" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${codicon(icon)}<span aria-hidden="true">${escapeHtml(label)}</span></button>`;
}

/** A treemap tab: where it is (the folder's path), its legend, the map, and the chosen file's strip. */
function treePanel(id: string, label: string): string {
  return `<section id="panel-${id}" class="insights-panel" role="tabpanel" aria-labelledby="tab-${id}" hidden>
    <div class="insights-summary"><nav id="${id}-crumbs" class="insights-crumbs" aria-label="${escapeHtml(localize("Folder"))}"></nav><span id="${id}-legend" class="insights-legend"></span></div>
    <div id="${id}-notes" class="insights-notes" hidden></div>
    <div id="${id}-map" class="treemap" tabindex="0" role="group" aria-roledescription="${escapeHtml(localize("treemap"))}" aria-label="${escapeHtml(label)}" aria-describedby="treemap-help"></div>
    <div id="${id}-empty" class="insights-empty" hidden></div>
    <div id="${id}-strip" class="insights-strip" hidden></div>
  </section>`;
}

/** Linyra Insights' markup; the extension host and the browser harness both render it. */
export function renderInsightsHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html class="insights-document" lang="${escapeHtml(language())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; img-src ${o.cspSource} data:; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>${escapeHtml(localize("Linyra Insights"))}</title>
</head>
<body>
<main id="insights" class="insights">
  <header class="insights-header">
    <div id="insights-tabs" class="insights-tabs" role="tablist" aria-label="${escapeHtml(localize("Insights"))}">
      ${tab("history", "history", localize("Visual History"))}
      ${tab("files", "files", localize("Files"))}
      ${tab("commits", "git-commit", localize("Commits"))}
      ${tab("health", "pass", localize("Health"))}
    </div>
    <div class="insights-controls">
      <label class="insights-field"><span class="insights-field-label">${escapeHtml(localize("Scope"))}</span><select id="scope" class="insights-select"></select></label>
      <div id="range" class="insights-segments" role="radiogroup" aria-label="${escapeHtml(localize("Range"))}"></div>
      <div id="color-by" class="insights-segments" role="radiogroup" aria-label="${escapeHtml(localize("Color by"))}"></div>
      <button id="refresh" class="icon-button" type="button" title="${escapeHtml(localize("Refresh"))}" aria-label="${escapeHtml(localize("Refresh"))}">${codicon("refresh")}</button>
    </div>
  </header>
  <section id="panel-history" class="insights-panel" role="tabpanel" aria-labelledby="tab-history">
    <div class="insights-summary"><span id="history-summary"></span><span id="history-legend" class="insights-legend"></span></div>
    <div id="history-notes" class="insights-notes" hidden></div>
    <div id="history-chart" class="history-chart" tabindex="0" role="group" aria-roledescription="${escapeHtml(localize("bubble chart"))}" aria-label="${escapeHtml(localize("Commits over time by author"))}" aria-describedby="history-help"></div>
    <div id="history-help" class="sr-only">${escapeHtml(localize("Arrow keys move between commits; Enter shows the commit in the Log."))}</div>
    <div id="history-empty" class="insights-empty" hidden></div>
  </section>
  ${treePanel("files", localize("Tracked files by size"))}
  ${treePanel("commits", localize("Files by commits in the range"))}
  <section id="panel-health" class="insights-panel" role="tabpanel" aria-labelledby="tab-health" hidden>
    <div id="health-toolbar" class="health-toolbar"></div>
    <div id="health-notes" class="insights-notes" hidden></div>
    <div class="health-table-wrap"><table id="health-table" class="health-table" aria-label="${escapeHtml(localize("Repository Health"))}" aria-describedby="health-help"></table></div>
    <div id="health-help" class="sr-only">${escapeHtml(localize("Up and Down arrows choose a repository; Space ticks it for Optimize Selected; Enter goes to its details."))}</div>
    <section id="health-details" class="health-details" hidden></section>
    <div id="health-empty" class="insights-empty" hidden></div>
  </section>
  <div id="treemap-help" class="sr-only">${escapeHtml(localize("Arrow keys move between tiles; Enter opens a folder or chooses a file; Backspace goes up a folder."))}</div>
  <div id="insights-tooltip" class="insights-tooltip" role="tooltip" hidden></div>
  <div id="insights-status" class="sr-only" role="status" aria-live="polite"></div>
</main>
${localizationScript(o.nonce)}
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}
