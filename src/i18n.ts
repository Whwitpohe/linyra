/** Shared by the extension host, pure view models and both webviews. */
export interface Localization {
  language: string;
  bundle: Readonly<Record<string, string>>;
}

let localization: Localization = { language: "en", bundle: {} };

export function configureI18n(language: string, bundle: Readonly<Record<string, string>> = {}): void {
  localization = { language, bundle };
}

export function language(): string {
  return localization.language;
}

/** Replace placeholders once: values such as paths and commit messages stay literal. */
export function localize(message: string, ...args: (string | number)[]): string {
  const translated = Object.prototype.hasOwnProperty.call(localization.bundle, message) ? localization.bundle[message] : message;
  return translated.replace(/\{(\d+)\}/g, (match, index: string) => args[Number(index)] === undefined ? match : String(args[Number(index)]));
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** JSON data, not executable code; escaping '<' also prevents a closing script tag. */
export function localizationScript(nonce: string): string {
  const json = JSON.stringify(localization).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `<script id="linyra-i18n" type="application/json" nonce="${escapeHtml(nonce)}">${json}</script>`;
}

// The host puts the locale before the bundled webview script, so even module-level
// initialization sees it. Pure Node tests and the browser harness default to English.
if (typeof document !== "undefined") {
  const data = document.getElementById("linyra-i18n")?.textContent;
  if (data) {
    const value = JSON.parse(data) as Localization;
    configureI18n(value.language, value.bundle);
  }
}
