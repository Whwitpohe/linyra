// How long the extension bundle takes to load (parse and evaluate its top level) before
// activate() runs, with a stub `vscode`. Dev-only; build the bundle first (npm run bundle:ext -- --minify):
//   node dev/perf/loadBench.mjs [bundle.js] [--runs 15]
// Each run is a fresh Node process: a module's code cache would make the second load free.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 15;
const bundle = path.resolve(process.argv[2]?.endsWith(".js") ? process.argv[2] : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "out", "extension.js"));
const probe = `
const Module = require("module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { return request === "vscode" ? "vscode" : resolve.call(this, request, ...rest); };
const stub = new Proxy(function () {}, { get: (t, k) => (k === "__esModule" ? false : stub), apply: () => stub, construct: () => stub });
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: stub };
const t = process.hrtime.bigint();
require(${JSON.stringify(bundle)});
process.stdout.write(String(Number(process.hrtime.bigint() - t) / 1e6));
`;
const times = [];
for (let i = 0; i < runs; i++) times.push(Number(execFileSync(process.execPath, ["-e", probe], { encoding: "utf8" })));
times.sort((a, b) => a - b);
console.log(`${path.basename(path.dirname(path.dirname(bundle)))}/${path.basename(bundle)}: median ${times[Math.floor(runs / 2)].toFixed(1)} ms, min ${times[0].toFixed(1)} ms over ${runs} runs`);
