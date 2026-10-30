// Folding linear history while the selected commit is inside a run (list.ts changeFolds): the
// selection moves to the run's top and the folded rows are drawn, not left as the rows before.
import { expect, test } from "@playwright/test";

const open = async (page) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/?theme=dark&state=default&avatars=off");
  await expect(page.locator("#rows .row").first()).toBeVisible();
};
const graphMenu = async (page, label) => {
  await page.locator('.column-button[data-key="graph"]').click();
  await page.locator(".popup-menu button", { hasText: label }).click();
};
const subjects = (page) => page.locator("#rows .row:not(.folded-row) .subject").allTextContents();

test("folding the run the selected commit is in draws the folded rows and selects the run's top", async ({ page }) => {
  await open(page);
  const before = await subjects(page);
  await graphMenu(page, "Collapse Linear Branches");
  await expect(page.locator("#rows .folded-row").first()).toBeVisible();
  const kept = new Set(await subjects(page));
  const hidden = before.filter((s) => !kept.has(s));
  expect(hidden.length).toBeGreaterThan(0);
  await graphMenu(page, "Expand Linear Branches");
  await expect(page.locator("#rows .folded-row")).toHaveCount(0);

  // Select a commit that a fold hides, then fold again.
  await page.locator("#rows .row .subject", { hasText: hidden[0] }).first().click();
  await expect(page.locator('#rows .row[aria-selected="true"] .subject')).toHaveText(hidden[0]);
  await graphMenu(page, "Collapse Linear Branches");
  await expect(page.locator("#rows .folded-row").first()).toBeVisible();
  expect(new Set(await subjects(page))).toEqual(kept);
  await expect(page.locator('#rows .row[aria-selected="true"]')).toHaveCount(1);
  expect(kept.has(await page.locator('#rows .row[aria-selected="true"] .subject').textContent())).toBe(true);
});
