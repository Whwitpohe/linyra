// Times Linyra's startup in a real VS Code against a generated 68-repo workspace.
//   npm run perf:startup
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const home = mkdtempSync(join(tmpdir(), "linyra-perf-home-"));
const ws = join(home, "work");
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = dana\n\temail = dana@example.com\n");
execFileSync("node", [join(root, "dev/perf/makeWorkspace.mjs"), ws, process.env.PERF_REPOS ?? "68"], { stdio: "inherit" });
await runTests({
  vscodeExecutablePath: await downloadAndUnzipVSCode("stable"),
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, "out/perf/index.js"),
  launchArgs: [ws, "--disable-extensions", "--disable-workspace-trust", "--no-sandbox"],
  extensionTestsEnv: { HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), LINYRA_ITEST: "1" },
});
