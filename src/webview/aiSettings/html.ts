import { escapeHtml, language, localizationScript, localize } from "../../i18n";
import { protocolDetail } from "../../ai/settingsModel";
import { PROTOCOLS, protocolName } from "../../ai/profileModel";
import { codicon } from "../codicons";
import type { HtmlOptions } from "../html";

/** The Linyra AI page: an editor tab with the AI profiles and the form that adds or edits one. */
export function renderAiSettingsHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html class="ai-document" lang="${escapeHtml(language())}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>${escapeHtml(localize("Linyra AI"))}</title>
</head>
<body id="ai-page">
${renderAiSettingsBody()}
${localizationScript(o.nonce)}
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}

const t = (text: string) => escapeHtml(text);
/** ✨ as the Log draws it: the sparkle codicon in the text's color, not the colored emoji. */
const sparkled = (text: string) => t(text).replace("✨", codicon("sparkle", "ai-inline-icon"));

export function renderAiSettingsBody(): string {
  const providers = PROTOCOLS.map((p) => `
        <label class="ai-provider">
          <input type="radio" name="ai-protocol" value="${p}">
          <span class="ai-provider-text"><span class="ai-provider-name">${t(protocolName(p))}</span><span class="ai-provider-detail">${t(protocolDetail(p))}</span></span>
        </label>`).join("");
  return `
<main id="ai-settings" class="ai-main">
  <header class="ai-header">
    <h1 class="ai-title">${codicon("sparkle", "ai-title-icon")}<span>${t(localize("Linyra AI"))}</span></h1>
    <p class="ai-lede">${t(localize("Prompts go only to the profile in use. API keys stay in VS Code's secret storage, never in settings."))}</p>
    <div class="ai-switch">
      <vscode-checkbox id="ai-enabled" toggle>${t(localize("AI features"))}</vscode-checkbox>
      <span id="ai-enabled-note" class="ai-hint"></span>
      <button id="ai-more" class="link-button" type="button">${t(localize("More settings…"))}</button>
    </div>
  </header>

  <div id="ai-announce" class="ai-sr" role="status" aria-live="polite"></div>
  <div id="ai-status" class="ai-status" hidden><span id="ai-status-icon" class="ai-status-icon" aria-hidden="true"></span><span id="ai-status-text"></span></div>

  <section class="ai-section" aria-labelledby="ai-profiles-title">
    <div class="ai-section-head">
      <h2 id="ai-profiles-title" class="ai-heading">${t(localize("Profiles"))}</h2>
      <button id="ai-add" class="button secondary" type="button">${codicon("add")}<span>${t(localize("Add Profile"))}</span></button>
    </div>
    <div id="ai-empty" class="ai-empty" hidden>
      ${codicon("sparkle", "ai-empty-icon")}
      <p class="ai-empty-title">${sparkled(localize("No AI profile yet — add one to use ✨ in the Log."))}</p>
      <p class="ai-hint">${t(localize("A profile is a provider, its address, a model and your API key. Linyra sends nothing until you add one and turn AI features on."))}</p>
    </div>
    <ul id="ai-profiles" class="ai-profiles" aria-labelledby="ai-profiles-title"></ul>
  </section>

  <section id="ai-editor" class="ai-section ai-editor" aria-labelledby="ai-form-title" hidden>
    <form id="ai-form" class="ai-form" novalidate>
      <h2 id="ai-form-title" class="ai-heading"></h2>

      <fieldset class="ai-field">
        <legend class="ai-label">${t(localize("Provider"))}</legend>
        <div class="ai-providers">${providers}
        </div>
      </fieldset>

      <div class="ai-field" id="ai-address-field">
        <label class="ai-label" for="ai-base-url">${t(localize("Address"))}</label>
        <div id="ai-address-fixed" class="ai-fixed">
          <span id="ai-address-fixed-text" class="ai-mono"></span>
          <button id="ai-address-custom" class="link-button" type="button">${t(localize("Use another address (gateway)…"))}</button>
        </div>
        <div id="ai-address-edit" class="ai-row">
          <input id="ai-base-url" class="ai-input ai-mono" type="url" spellcheck="false" autocomplete="off" aria-describedby="ai-base-url-msg ai-base-url-hint">
          <button id="ai-address-reset" class="link-button" type="button"></button>
        </div>
        <div id="ai-presets" class="ai-presets" role="group" aria-label="${t(localize("Common addresses"))}"></div>
        <p id="ai-base-url-msg" class="ai-message" hidden></p>
        <p id="ai-base-url-hint" class="ai-hint">${t(localize("The API's base URL. Change it for a local server or a gateway."))}</p>
      </div>

      <div class="ai-field" id="ai-key-field">
        <label class="ai-label" for="ai-key" id="ai-key-label">${t(localize("API key"))}</label>
        <div id="ai-key-stored" class="ai-fixed" role="group" aria-labelledby="ai-key-label ai-key-stored-text">
          ${codicon("key", "ai-key-icon")}<span id="ai-key-stored-text"></span>
          <button id="ai-key-replace" class="button secondary small" type="button" aria-label="${t(localize("Replace the stored API key"))}">${t(localize("Replace"))}</button>
          <button id="ai-key-remove" class="button secondary small" type="button" aria-label="${t(localize("Remove the stored API key"))}">${t(localize("Remove"))}</button>
        </div>
        <div id="ai-key-entry" class="ai-row">
          <input id="ai-key" class="ai-input ai-mono" type="password" spellcheck="false" autocomplete="off" aria-describedby="ai-key-msg ai-key-note">
          <button id="ai-key-cancel" class="link-button" type="button">${t(localize("Keep the stored key"))}</button>
        </div>
        <p id="ai-key-msg" class="ai-message" hidden></p>
        <p id="ai-key-note" class="ai-hint"></p>
      </div>

      <div class="ai-field">
        <label class="ai-label" for="ai-model">${t(localize("Model"))}</label>
        <div id="ai-model-box" class="ai-row ai-combo">
          <input id="ai-model" class="ai-input ai-mono" type="text" spellcheck="false" autocomplete="off" aria-label="${t(localize("Model"))}" aria-describedby="ai-model-msg ai-model-note">
          <button id="ai-model-open" class="icon-button" type="button" tabindex="-1" title="${t(localize("Show the models"))}" aria-label="${t(localize("Show the models"))}">${codicon("chevron-down")}</button>
          <button id="ai-model-reload" class="icon-button" type="button" title="${t(localize("Reload the model list"))}" aria-label="${t(localize("Reload the model list"))}">${codicon("refresh")}</button>
        </div>
        <p id="ai-model-msg" class="ai-message" hidden></p>
        <p id="ai-model-note" class="ai-hint" aria-live="polite"></p>
      </div>

      <fieldset class="ai-field" id="ai-effort-field">
        <legend class="ai-label">${t(localize("Thinking level"))}</legend>
        <div id="ai-efforts" class="ai-segments"></div>
        <p id="ai-effort-note" class="ai-hint"></p>
      </fieldset>

      <div class="ai-field">
        <label class="ai-label" for="ai-name">${t(localize("Name"))}</label>
        <input id="ai-name" class="ai-input" type="text" spellcheck="false" autocomplete="off" aria-describedby="ai-name-msg ai-name-hint">
        <p id="ai-name-msg" class="ai-message" hidden></p>
        <p id="ai-name-hint" class="ai-hint">${t(localize("Leave it empty to name it after the provider and the model."))}</p>
      </div>

      <div class="ai-field" id="ai-use-field">
        <vscode-checkbox id="ai-use">${t(localize("Use this profile for Linyra AI"))}</vscode-checkbox>
      </div>

      <div class="ai-test">
        <div class="ai-row">
          <button id="ai-test" class="button secondary" type="button">${t(localize("Test Connection"))}</button>
          <span id="ai-test-progress" class="ai-hint"></span>
        </div>
        <div id="ai-test-result" class="ai-result" hidden>
          <p id="ai-test-title" class="ai-result-title"></p>
          <ul id="ai-test-lines" class="ai-result-lines"></ul>
        </div>
      </div>

      <div class="ai-actions">
        <button id="ai-save" class="button primary" type="submit">${t(localize("Save"))}</button>
        <button id="ai-cancel" class="button secondary" type="button">${t(localize("Cancel"))}</button>
        <span id="ai-save-error" class="ai-message error" hidden></span>
      </div>
    </form>
  </section>
</main>
`;
}
