import { escapeHtml, language, localizationScript, localize } from "../../i18n";
import type { HtmlOptions } from "../html";

/** The Commit side bar's message box, below its native tree of changes. */
export function renderCommitHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html class="commit-document" lang="${escapeHtml(language())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>${escapeHtml(localize("Commit Message"))}</title>
</head>
<body id="commit-pane">
${renderCommitBody()}
${localizationScript(o.nonce)}
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}

export function renderCommitBody(): string {
  return `
<main id="commit" class="commit-form" aria-label="${escapeHtml(localize("Commit"))}">
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
</main>
`;
}
