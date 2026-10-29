// Builds (or serves) the webview in a plain browser: the real bundle and the
// real markup from src/webview/html.ts, plus a host shim and theme variables.
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });

// One markup source: render the production HTML, then swap its CSP (there is no
// host to enforce it against) for the theme stylesheet and host shim.
const { outputFiles } = await esbuild.build({
  stdin: { contents: 'export { renderHtml } from "./src/webview/html"; export { renderReposHtml } from "./src/webview/compare/html"; export { renderChangesHtml } from "./src/webview/changes/html"; export { renderCommitHtml } from "./src/webview/commit/html"; export { renderAiSettingsHtml } from "./src/webview/aiSettings/html"; export { renderFormHtml } from "./src/webview/form/html"; export { renderInsightsHtml } from "./src/webview/insights/html"; export { configureI18n } from "./src/i18n";', resolveDir: root },
  bundle: true, format: "esm", platform: "node", write: false,
});
const { renderHtml, renderReposHtml, renderChangesHtml, renderCommitHtml, renderAiSettingsHtml, renderFormHtml, renderInsightsHtml, configureI18n } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
for (const locale of ["en", "zh-cn"]) {
  const bundle = locale === "en" ? {} : JSON.parse(readFileSync(join(root, `l10n/bundle.l10n.${locale}.json`), "utf8"));
  configureI18n(locale, bundle);
  const suffix = locale === "en" ? "" : `.${locale}`;
  for (const [name, render, script, style, shim] of [
    ["index", renderHtml, "webview.js", "webview.css", "shim.js"],
    ["repos", renderReposHtml, "compare.js", "compare.css", "compareShim.js"],
    ["changes", renderChangesHtml, "changes.js", "changes.css", "changesShim.js"],
    ["commit", renderCommitHtml, "commit.js", "commit.css", "commitShim.js"],
    ["aiSettings", renderAiSettingsHtml, "aiSettings.js", "aiSettings.css", "aiSettingsShim.js"],
    ["form", renderFormHtml, "form.js", "form.css", "formShim.js"],
    ["insights", renderInsightsHtml, "insights.js", "insights.css", "insightsShim.js"],
  ]) {
    const html = render({ cspSource: "", nonce: "harness", scriptUri: script, styleUri: style })
      .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, "")
      .replace("</head>", '<link id="theme" rel="stylesheet" href="themes/dark.css">\n</head>')
      .replace('<script nonce="harness" src=', `<script src="${shim}"></script>\n<script nonce="harness" src=`);
    writeFileSync(join(dist, `${name}${suffix}.html`), html);
  }
}
cpSync(join(here, "themes"), join(dist, "themes"), { recursive: true });
cpSync(join(here, "gallery.html"), join(dist, "gallery.html"));

const contexts = await Promise.all([
  esbuild.context({ entryPoints: [join(root, "src/webview/main.ts")], bundle: true, format: "iife", outfile: join(dist, "webview.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(here, "shim.ts")], bundle: true, format: "iife", outfile: join(dist, "shim.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(root, "src/webview/compare/main.ts")], bundle: true, format: "iife", outfile: join(dist, "compare.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(here, "compareShim.ts")], bundle: true, format: "iife", outfile: join(dist, "compareShim.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(root, "src/webview/changes/main.ts")], bundle: true, format: "iife", outfile: join(dist, "changes.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(here, "changesShim.ts")], bundle: true, format: "iife", outfile: join(dist, "changesShim.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(root, "src/webview/commit/main.ts")], bundle: true, format: "iife", outfile: join(dist, "commit.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(here, "commitShim.ts")], bundle: true, format: "iife", outfile: join(dist, "commitShim.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(root, "src/webview/aiSettings/main.ts")], bundle: true, format: "iife", outfile: join(dist, "aiSettings.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(here, "aiSettingsShim.ts")], bundle: true, format: "iife", outfile: join(dist, "aiSettingsShim.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(root, "src/webview/form/main.ts")], bundle: true, format: "iife", outfile: join(dist, "form.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(here, "formShim.ts")], bundle: true, format: "iife", outfile: join(dist, "formShim.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(root, "src/webview/insights/main.ts")], bundle: true, format: "iife", outfile: join(dist, "insights.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(here, "insightsShim.ts")], bundle: true, format: "iife", outfile: join(dist, "insightsShim.js"), sourcemap: true }),
]);

if (process.argv.includes("--serve")) {
  await Promise.all(contexts.map((c) => c.watch()));
  const { port } = await contexts[0].serve({ servedir: dist, host: "127.0.0.1", port: Number(process.env.HARNESS_PORT) || 5178 });
  console.log(`harness:  http://127.0.0.1:${port}/?theme=dark&state=default`);
  console.log(`gallery:  http://127.0.0.1:${port}/gallery.html?state=default`);
  console.log(`repos:    http://127.0.0.1:${port}/repos.html?theme=dark`);
  console.log(`commit:   http://127.0.0.1:${port}/commit.html?theme=dark`);
  console.log(`ai:       http://127.0.0.1:${port}/aiSettings.html?theme=dark`);
  console.log(`form:     http://127.0.0.1:${port}/form.html?theme=dark&form=release`);
  console.log(`insights: http://127.0.0.1:${port}/insights.html?theme=dark&tab=history`);
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  console.log(`harness built to ${dist}`);
}
