import { escapeHtml, language, localizationScript, localize } from "../../i18n";
import { codicon } from "../codicons";
import type { HtmlOptions } from "../html";

export function renderCommitHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html class="commit-document" lang="${escapeHtml(language())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>${escapeHtml(localize("Commit"))}</title>
</head>
<body id="commit-pane">
${renderCommitBody()}
${localizationScript(o.nonce)}
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}

const iconButton = (id: string, label: string, icon: Parameters<typeof codicon>[0]) =>
  `<button id="${id}" class="icon-button" type="button" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${codicon(icon)}</button>`;

export function renderCommitBody(): string {
  return `
<main id="commit" class="commit-view">
  <div class="commit-toolbar">
    <span id="commit-summary" class="commit-summary"></span>
    ${iconButton("commit-refresh", localize("Refresh"), "refresh")}
    ${iconButton("commit-rollback", `${localize("Rollback…")} (Ctrl+Alt+Z)`, "discard")}
    ${iconButton("commit-diff", `${localize("Show Diff")} (Enter)`, "diff")}
    <button id="commit-tree-toggle" class="icon-button" type="button" aria-controls="commit-tree" aria-label="${escapeHtml(localize("Collapse All"))}" disabled></button>
  </div>
  <div id="commit-notice" class="notice" role="status" hidden></div>
  <div id="commit-tree" class="commit-tree" role="tree" aria-multiselectable="true" aria-label="${escapeHtml(localize("Changes to commit"))}" tabindex="0"></div>
  <div id="commit-splitter" class="commit-splitter" role="separator" aria-orientation="horizontal" aria-controls="commit-form" aria-label="${escapeHtml(localize("Resize the commit message"))}" title="${escapeHtml(localize("Drag to resize the commit message. Double-click to reset."))}" tabindex="0"></div>
  <section id="commit-form" class="commit-form" aria-label="${escapeHtml(localize("Commit"))}">
    <div class="commit-options">
      <span id="commit-amend" class="check-option" role="checkbox" aria-checked="false" tabindex="0"><span class="check" aria-hidden="true"></span>${escapeHtml(localize("Amend"))}</span>
    </div>
    <textarea id="commit-message" class="commit-message" placeholder="${escapeHtml(localize("Commit Message"))}" aria-label="${escapeHtml(localize("Commit Message"))}" aria-describedby="commit-validation" spellcheck="true"></textarea>
    <div id="commit-validation" class="validation" role="alert" hidden></div>
    <div class="commit-buttons">
      <button id="commit-button" class="button primary" type="button" title="${escapeHtml(localize("Commit"))} (Ctrl+Enter)">${escapeHtml(localize("Commit"))}</button>
      <button id="commit-push-button" class="button secondary" type="button" title="${escapeHtml(localize("Commit and Push…"))} (Ctrl+Alt+K)">${escapeHtml(localize("Commit and Push…"))}</button>
    </div>
    <div id="commit-checked" class="commit-checked" aria-live="polite"></div>
  </section>
</main>
`;
}
