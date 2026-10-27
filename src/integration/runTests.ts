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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-itest-home-"));
  // The user's own identity, which the "Me" author button reads from git config.
  fs.writeFileSync(path.join(home, ".gitconfig"), "[user]\n\tname = dana\n\temail = dana@example.com\n");
  const ws = path.join(home, "ws");
  for (const [name, commits] of Object.entries(FIXTURE)) makeRepo(path.join(ws, name), commits, home);
  // A repo-local identity, like a personal repo inside a work workspace.
  execFileSync("git", ["config", "user.email", "rin@example.com"], { cwd: path.join(ws, "acme-libs"), env: gitEnv(home) });
  // Only acme-api has a "prod" branch, one commit behind main.
  execFileSync("git", ["branch", "prod", "HEAD~1"], { cwd: path.join(ws, "acme-api"), env: gitEnv(home) });
  const workspaceFile = path.join(home, "acme.code-workspace");
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders: Object.keys(FIXTURE).map((n) => ({ path: path.join(ws, n) })) }));
  const env = gitEnv(home);

  await runTests({
    vscodeExecutablePath: await downloadAndUnzipVSCode(process.env.POLYLOG_VSCODE_VERSION ?? "stable"),
    extensionDevelopmentPath: repoRoot,
    extensionTestsPath: path.resolve(__dirname, "index.js"),
    launchArgs: [workspaceFile, "--disable-extensions", "--disable-workspace-trust", "--no-sandbox"],
    extensionTestsEnv: {
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_NOSYSTEM: env.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL,
      POLYLOG_ITEST: "1",
    },
  });
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
