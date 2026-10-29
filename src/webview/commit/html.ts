import { escapeHtml, language, localizationScript, localize } from "../../i18n";
import { codicon } from "../codicons";
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
    <span id="commit-amend" class="check-option" role="checkbox" aria-checked="false" tabindex="0" title="${escapeHtml(localize("Amend the last commit (git commit --amend)"))}"><span class="check" aria-hidden="true"></span><span class="check-label">${escapeHtml(localize("Amend"))}</span></span>
    <span id="commit-signoff" class="check-option" role="checkbox" aria-checked="false" tabindex="0" title="${escapeHtml(localize("Add a Signed-off-by line (git commit --signoff)"))}"><span class="check" aria-hidden="true"></span><span class="check-label">${escapeHtml(localize("Sign-off"))}</span></span>
    <span class="commit-tools">
      <button id="commit-generate" class="icon-button" type="button" title="${escapeHtml(localize("Generate Commit Message with AI"))}" aria-label="${escapeHtml(localize("Generate Commit Message with AI"))}" hidden>${codicon("sparkle")}</button>
      <button id="commit-author" class="icon-button" type="button" title="${escapeHtml(localize("Author…"))}" aria-label="${escapeHtml(localize("Author…"))}">${codicon("person")}</button>
      <button id="commit-history" class="icon-button" type="button" title="${escapeHtml(localize("Commit Message History"))} (Ctrl+M)" aria-label="${escapeHtml(localize("Commit Message History"))}">${codicon("history")}</button>
    </span>
  </div>
  <div id="commit-author-line" class="commit-author" hidden>
    <button id="commit-author-edit" class="link-button" type="button" title="${escapeHtml(localize("Author…"))}"></button>
    <button id="commit-author-clear" class="icon-button" type="button" title="${escapeHtml(localize("Use your own git user"))}" aria-label="${escapeHtml(localize("Use your own git user"))}">${codicon("close")}</button>
  </div>
  <textarea id="commit-message" class="commit-message" placeholder="${escapeHtml(localize("Commit Message"))}" aria-label="${escapeHtml(localize("Commit Message"))}" aria-describedby="commit-validation commit-hints" spellcheck="true"></textarea>
  <div id="commit-validation" class="validation" role="alert" hidden></div>
  <ul id="commit-hints" class="commit-hints" hidden></ul>
  <p id="commit-guidance" class="commit-guidance" hidden></p>
  <div id="commit-ai-status" class="commit-ai-status" aria-live="polite" hidden><span id="commit-ai-text" class="commit-ai-text"></span><button id="commit-ai-undo" class="link-button" type="button" hidden>${escapeHtml(localize("Undo"))}</button></div>
  <div class="commit-buttons">
    <button id="commit-button" class="button primary" type="button" title="${escapeHtml(localize("Commit"))} (Ctrl+Enter)">${escapeHtml(localize("Commit"))}</button>
    <button id="commit-push-button" class="button secondary" type="button" title="${escapeHtml(localize("Commit and Push…"))} (Ctrl+Alt+K)">${escapeHtml(localize("Commit and Push…"))}</button>
  </div>
  <div id="commit-checked" class="commit-checked" aria-live="polite"></div>
</main>
`;
}
