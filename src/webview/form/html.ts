import { escapeHtml, language, localizationScript, localize } from "../../i18n";
import type { HtmlOptions } from "../html";

/** A review form's page (Release…, Tag Across Repositories…): the host sends its fields once it is ready. */
export function renderFormHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(language())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>${escapeHtml(localize("Linyra"))}</title>
</head>
<body>
<main id="form-app" class="form-app">
  <form id="form" class="review-form" novalidate>
    <h1 id="form-title" class="form-title"></h1>
    <p id="form-intro" class="form-intro"></p>
    <div id="form-fields" class="form-fields"></div>
    <div class="form-actions">
      <button id="form-submit" class="primary-button" type="submit"></button>
      <button id="form-cancel" class="secondary-button" type="button"></button>
      <span id="form-status" class="form-status" role="status" aria-live="polite"></span>
    </div>
  </form>
</main>
${localizationScript(o.nonce)}
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}
