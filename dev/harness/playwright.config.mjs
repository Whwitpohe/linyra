// UI tests against the dev harness: the production webview HTML/CSS/JS with mock data and the
// --vscode-* variables of each theme. Run with `npm run test:ui`.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.mjs",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://localhost:5178", browserName: "chromium" },
  webServer: {
    command: "node dev/harness/build.mjs --serve",
    cwd: "../..",
    url: "http://localhost:5178/index.html",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
