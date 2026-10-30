// Every bundle the extension builds and loads ships in the VSIX. .vscodeignore is an allowlist: a
// bundle that is built and loaded but not listed works from the repository (where the integration
// tests run) and is missing from the installed extension. The Linyra AI page shipped that way, as
// its text without its script or stylesheet. Fail when package.json builds, or the code loads,
// a file of out/ the allowlist leaves out.
import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shipped = new Set(readFileSync(path.join(root, ".vscodeignore"), "utf8").split(/\r?\n/)
  .filter((line) => line.startsWith("!out/")).map((line) => line.slice("!out/".length)));

// What package.json's bundle scripts write: out/<name>.js.
const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;
const built = Object.entries(scripts).filter(([name]) => name.startsWith("bundle:"))
  .flatMap(([, command]) => [...command.matchAll(/--outfile=out\/([\w.-]+)/g)].map((m) => m[1]));
assert.ok(built.length >= 9, `package.json's bundle scripts were found (${built.join(", ")})`);
for (const file of built) assert.ok(shipped.has(file), `out/${file} is built but .vscodeignore does not ship it`);

// What the code loads at run time: a bundle's file name, in a string of the extension's own source.
const sources = (dir) => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  if (statSync(full).isDirectory()) return name === "integration" ? [] : sources(full);
  return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
});
const loaded = new Map();
for (const file of sources(path.join(root, "src"))) {
  for (const m of readFileSync(file, "utf8").matchAll(/"([A-Za-z][\w-]*\.(?:js|css))"/g)) loaded.set(m[1], path.relative(root, file));
}
assert.ok(loaded.has("webview.js") && loaded.has("aiSettings.css"), "the panels' bundle names were found in the source");
for (const [file, where] of loaded) assert.ok(shipped.has(file), `${where} loads out/${file}, which .vscodeignore does not ship`);
console.log("ok - every bundle package.json builds and the code loads ships in the VSIX");
