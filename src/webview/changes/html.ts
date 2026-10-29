import { escapeHtml, language, localizationScript, localize } from "../../i18n";
import { codicon } from "../codicons";
import type { HtmlOptions } from "../html";

export function renderChangesHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html class="changes-document" lang="${escapeHtml(language())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>${escapeHtml(localize("Changes"))}</title>
</head>
<body id="changes-pane">
${renderChangesBody()}
${localizationScript(o.nonce)}
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}

export function renderChangesBody(): string {
  return `
<main id="changes" class="changes">
  <section id="files-pane" class="files-pane" aria-label="${escapeHtml(localize("Changed files"))}">
    <div id="changes-heading" class="files-heading"><span id="summary"></span>
      <button id="changes-clear-selection" class="icon-button" type="button" title="${escapeHtml(localize("Clear Selection"))}" aria-label="${escapeHtml(localize("Clear Selection"))}" disabled>${codicon("clear-all")}</button>
      <button id="changes-all-files" class="icon-button" type="button" aria-label="${escapeHtml(localize("Show All Files"))}"></button>
      <button id="changes-tree-toggle" class="icon-button" type="button" aria-controls="file-tree" aria-label="${escapeHtml(localize("Collapse All"))}" disabled></button>
      <button id="changes-more" class="icon-button" type="button" title="${escapeHtml(localize("More Changes Actions"))}" aria-label="${escapeHtml(localize("More Changes Actions"))}" aria-haspopup="menu" aria-expanded="false">${codicon("ellipsis")}</button>
    </div>
    <div class="files-filter"><input id="file-filter" type="search" placeholder="${escapeHtml(localize("Filter changed files by name or path"))}" aria-label="${escapeHtml(localize("Filter changed files by name or path"))}" aria-controls="file-tree" autocomplete="off" spellcheck="false"><span id="file-filter-count" class="file-filter-count" role="status" hidden></span></div>
    <div id="notice" class="notice" role="status" hidden></div>
    <div id="file-filter-empty" class="notice" role="status" hidden></div>
    <div id="file-tree" class="file-tree" role="tree" aria-multiselectable="true" aria-label="${escapeHtml(localize("Changed files"))}" tabindex="0"></div>
  </section>
  <div id="detail-splitter" class="detail-splitter" role="separator" aria-orientation="horizontal" aria-label="${escapeHtml(localize("Resize commit details"))}" title="${escapeHtml(localize("Drag to resize commit details. Double-click to reset."))}" aria-controls="commit-details" tabindex="0" hidden></div>
  <div id="detail-heading" class="detail-heading" hidden><button id="detail-toggle" class="detail-toggle" type="button" aria-expanded="true" aria-controls="commit-details" aria-label="${escapeHtml(localize("Hide commit details"))}" title="${escapeHtml(localize("Hide commit details"))}">${codicon("chevron-down", "detail-chevron")}</button><span class="detail-heading-label"><span class="detail-heading-commit">${escapeHtml(localize("Commit details"))}</span><span class="detail-heading-branch">${escapeHtml(localize("Branch"))}</span></span></div>
  <section id="commit-details" class="commit-details" aria-label="${escapeHtml(localize("Commit details"))}" tabindex="0" hidden></section>
  <section id="branch-sheet" class="branch-sheet" role="region" tabindex="-1"></section>
</main>
<div id="copy-status" class="sr-only" role="status"></div>
<div id="changes-actions" class="changes-menu" role="menu" aria-label="${escapeHtml(localize("More Changes Actions"))}" hidden>
  <button id="changes-copy-sha" type="button" role="menuitem">${escapeHtml(localize("Copy Commit SHA"))}</button>
  <button id="changes-copy-message" type="button" role="menuitem">${escapeHtml(localize("Copy Commit Message"))}</button>
  <button id="changes-open-remote" type="button" role="menuitem">${escapeHtml(localize("Open on Remote"))}</button>
  <button id="changes-open-editor" type="button" role="menuitem">${escapeHtml(localize("Open Changes in Editor"))}</button>
</div>
`;
}
