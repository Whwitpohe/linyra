// The unit tests: the scripts' own *.test.mjs, then every src/**/*.test.ts bundled by esbuild
// and run with node, one process per file. A new test file runs without being registered
// anywhere, so none can be forgotten. Bundles go straight into out/ (tests find the
// repository root as __dirname/..). Stops at the first failing file, like the && chain it replaces.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function find(dir, suffix) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) return e.name === "integration" ? [] : find(rel, suffix);
    return e.name.endsWith(suffix) ? [rel] : [];
  }).sort();
}

function run(file) {
  const r = spawnSync(process.execPath, [file], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`not ok - ${path.relative(root, file)} exited with ${r.status ?? r.signal}`);
    process.exit(1);
  }
}

for (const script of find("scripts", ".test.mjs")) run(path.join(root, script));

const sources = find("src", ".test.ts");
// src/webview/compare/html.test.ts → out/webview-compare-html.test.cjs
const outOf = (src) => path.join(root, "out", src.slice("src/".length).replace(/\.ts$/, ".cjs").split("/").join("-"));
await Promise.all(sources.map((src) => build({
  entryPoints: [path.join(root, src)], bundle: true, platform: "node", format: "cjs", outfile: outOf(src), logLevel: "warning",
})));
for (const src of sources) run(outOf(src));
console.log(`ok - ${sources.length} unit test files`);
