// UI tests against the dev harness: the production webview HTML/CSS/JS with mock data and the
// --vscode-* variables of each theme. Run with `npm run test:ui`.
import { defineConfig } from "@playwright/test";

// HARNESS_PORT: run several harnesses side by side (one per worktree). 127.0.0.1, not every
// interface: Windows Firewall asks (with UAC) about a program listening on the network.
const port = Number(process.env.HARNESS_PORT) || 5178;

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.mjs",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: "chromium" },
  webServer: {
    command: "node dev/harness/build.mjs --serve",
    cwd: "../..",
    url: `http://127.0.0.1:${port}/index.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
