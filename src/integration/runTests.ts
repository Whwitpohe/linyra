// Runs OUTSIDE VS Code, in plain node. Never import "vscode" here.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { gitEnv, makeRepo } from "../fixtures";
import { FIXTURE } from "./fixture";

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..", ".."); // out/integration → repo root
  // Throwaway HOME: no real git config, no real VS Code state.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-itest-home-"));
  // The user's own identity, which the "Me" author button reads from git config.
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = dana\n\temail = dana@example.com\n");
  const ws = path.join(home, "ws");
  for (const [name, commits] of Object.entries(FIXTURE)) makeRepo(path.join(ws, name), commits, home);
  // A repo-local identity, like a personal repo inside a work workspace.
  execFileSync("git", ["config", "user.email", "rin@example.com"], { cwd: path.join(ws, "acme-libs"), env: gitEnv(home) });
  // Only acme-api has a "prod" branch, one commit behind main.
  execFileSync("git", ["branch", "prod", "HEAD~1"], { cwd: path.join(ws, "acme-api"), env: gitEnv(home) });
  const workspaceFile = path.join(home, "acme.code-workspace");
  fs.writeFileSync(workspaceFile, JSON.stringify({
    folders: Object.keys(FIXTURE).map((n) => ({ path: path.join(ws, n) })),
    // Retired Polylog settings must neither affect Linyra nor be copied on activation.
    settings: { "polylog.pageSize": 1, "polylog.maxConcurrency": 1, "polylog.scanDepth": 0,
      "polylog.excludeRepos": ["acme-libs"], "polylog.profiles": { retired: ["acme-api"] }, "polylog.blame": false },
  }));
  const env = gitEnv(home);

  await runTests({
    vscodeExecutablePath: await downloadAndUnzipVSCode(process.env.LINYRA_VSCODE_VERSION ?? "stable"),
    extensionDevelopmentPath: repoRoot,
    extensionTestsPath: path.resolve(__dirname, "index.js"),
    // Its own user data in the throwaway HOME: worktrees sharing one .vscode-test can run side by side.
    launchArgs: [workspaceFile, "--disable-extensions", "--disable-workspace-trust", "--no-sandbox", `--user-data-dir=${path.join(home, "vscode-user")}`, `--extensions-dir=${path.join(home, "vscode-ext")}`],
    extensionTestsEnv: {
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_NOSYSTEM: env.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL,
      LINYRA_ITEST: "1",
      // Only the tests whose title matches (mocha's grep): one test again in a minute instead of every suite.
      // The suites share one workspace and build on each other: a full run is still the check.
      LINYRA_ITEST_GREP: process.env.LINYRA_ITEST_GREP ?? "",
    },
  });
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
