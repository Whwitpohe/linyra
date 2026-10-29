// The Log header's ✨ Ask AI… button: hidden while AI is off (linyra.ai.enabled), shown once the
// host's toolbar state says it is on, and a click asks the host to run linyra.ai.ask.
import { expect, test } from "@playwright/test";

test("✨ Ask AI… shows only while AI is on, and runs the Ask AI action", async ({ page }) => {
  await page.goto("/?theme=dark&state=default");
  await expect(page.locator("#rows .row").first()).toBeVisible();
  const button = page.locator("#toolbar-ai");
  await expect(button).toBeHidden();
  const state = { groupByRepo: true, compareShown: false, fetching: false, anyBehind: true, ai: true };
  await page.evaluate((s) => window.postMessage({ type: "toolbar", state: s }, "*"), state);
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-label", "Ask AI…");
  await expect(button.locator("svg")).toHaveCount(1);
  await button.click();
  expect(await page.evaluate(() => window.harnessMessages.filter((m) => m.type === "toolbarAction").map((m) => m.action))).toContain("aiAsk");
  await page.evaluate((s) => window.postMessage({ type: "toolbar", state: { ...s, ai: false } }, "*"), state);
  await expect(button).toBeHidden();
});
