// Packages the working tree and installs it into the local VS Code as <version>+<commit>
// (with .dirty when the tree has uncommitted changes), e.g. 1.5.0+0c04e40, so the Extensions
// view tells a local build from the published one. package.json keeps its version: the
// suffix is passed to vsce only. It is semver build metadata ("+", not "-"): 1.5.0-0c04e40
// would be a pre-release *older* than 1.5.0, and VS Code would offer the published 1.5.0 as
// an update over the newer local build. LINYRA_CODE names another CLI (code-insiders, cursor).
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const dirty = git("status", "--porcelain") !== "";
const version = `${pkg.version}+${git("rev-parse", "--short", "HEAD")}${dirty ? ".dirty" : ""}`;
const id = `${pkg.publisher}.${pkg.name}`;
const vsix = path.join(root, "out", "local.vsix");
const code = process.env.LINYRA_CODE || "code";

// npx and the editor CLIs are .cmd shims on Windows, which only a shell can start; one command
// line, since Node deprecates passing arguments alongside `shell`. The command stays unquoted:
// a .cmd started by a quoted name finds its own files relative to the current directory.
const line = (cmd, args) => [cmd, ...args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a}"` : a))].join(" ");

function run(cmd, args) {
  const r = spawnSync(line(cmd, args), { cwd: root, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`install-local: ${cmd} ${args.join(" ")} exited with ${r.status ?? r.signal}`);
    process.exit(1);
  }
}

run("npx", ["vsce", "package", version, "--no-update-package-json", "--no-git-tag-version", "--no-dependencies", "--out", vsix]);
run(code, ["--install-extension", vsix, "--force"]);
const installed = execFileSync(line(code, ["--list-extensions", "--show-versions"]), { encoding: "utf8", shell: true })
  .split(/\r?\n/).find((l) => l.toLowerCase().startsWith(`${id}@`));
if (installed !== `${id}@${version}`) {
  console.error(`install-local: expected ${id}@${version}, ${code} lists ${installed ?? "nothing"}`);
  process.exit(1);
}
console.log(`ok - installed ${installed}; reload the VS Code window (Developer: Reload Window) to run it`);
