// The Linyra Compare tab against the dev harness: a side with several names, the Repositories
// rows' merge notes and All repositories, a side's filter and multi-select, and the toolbar's
// Only Conflicts, Merge and Release Notes, in every theme.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", pair = "", width = 1400, height = 420 } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/repos.html?theme=${theme}${pair ? `&pair=${pair}` : ""}`);
  await expect(page.locator("#repo-list .crepo").first()).toBeVisible();
  return errors;
};
const sent = (page, type) => page.evaluate((t) => window.compareMessages.filter((m) => m.type === t), type);

test("a side lists several names: + adds the next one to try, × removes one, the box shows them in order", async ({ page }) => {
  await open(page);
  await page.locator("#branch-left").click();
  await expect(page.locator("#picker")).toBeVisible();
  // Default branch: each repository's origin/HEAD.
  await expect(page.locator(".picker-group", { hasText: "Default branch" })).toBeVisible();
  await page.locator(".picker-row", { hasText: "origin/release-1.3" }).locator(".picker-add").click();
  await expect(page.locator("#name-left")).toHaveText("origin/release-1.4, origin/release-1.3");
  await expect.poll(async () => (await sent(page, "pick")).at(-1)?.pair).toEqual({ left: "origin/release-1.4 origin/release-1.3", right: "origin/main" });
  // The picker stays open on this side's names, in order.
  await expect(page.locator(".picker-row.candidate")).toHaveText([/1\.\s*origin\/release-1\.4/, /2\.\s*origin\/release-1\.3/]);
  await page.locator(".picker-row.candidate").first().locator(".picker-remove").click();
  await expect(page.locator("#name-left")).toHaveText("origin/release-1.3");
  // A plain pick replaces the side.
  await page.locator(".picker-row", { hasText: "feat/billing" }).click();
  await expect(page.locator("#name-left")).toHaveText("feat/billing");
});

test("Repositories: each row's merge note and the names it uses; All repositories puts every one in one tree", async ({ page }) => {
  await open(page, { pair: "several" });
  const api = page.locator('.crepo[data-repo="/work/acme-api"]');
  await expect(api.locator(".repo-names")).toHaveText("develop-k → main");
  await expect(api.locator(".row-note.conflict")).toHaveText("1");
  await expect(page.locator('.crepo[data-repo="/work/acme-web"] .row-note.clean')).toBeVisible();
  await expect(page.locator('.crepo[data-repo="/work/acme-libs"] .row-note')).toHaveCount(0);
  const all = page.locator('.crepo[data-repo="*"]');
  await expect(all).toContainText("All repositories");
  await all.click();
  await expect.poll(async () => (await sent(page, "select")).at(-1)?.repoId).toBe("*");
  await expect(page.locator("#compare-left-tree .compare-tree-row", { hasText: "acme-api" })).toBeVisible();
  await expect(page.locator("#compare-left-tree .compare-tree-row.conflict-file").first()).toBeVisible();
});

test("a side's filter keeps matching rows and their folders; Ctrl/Shift-click selects several", async ({ page }) => {
  await open(page);
  const rows = page.locator("#compare-left-tree .compare-tree-row");
  await expect(rows).toHaveCount(3);
  await page.locator("#compare-left-filter").fill("upload");
  await expect(rows).toHaveText([/src/, /upload\.ts/]);
  await page.locator("#compare-left-filter").press("Escape");
  await expect(rows).toHaveCount(3);
  await rows.nth(1).click();
  await rows.nth(2).click({ modifiers: ["Control"] });
  await expect(page.locator("#compare-left-tree .compare-tree-row.selected")).toHaveCount(2);
  await expect.poll(async () => (await sent(page, "sideSelect")).at(-1)?.ids.length).toBe(2);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("Only Conflicts lists only the conflicted files; Merge and Release Notes reach the host", async ({ page }) => {
  await open(page);
  const button = page.locator("#compare-only-conflicts");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#compare-left-tree .compare-tree-row", { hasText: ".ts" })).toHaveText([/limits\.ts/]);
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "false");
  await page.locator("#compare-merge").click();
  await page.locator("#compare-release-notes").click();
  await expect.poll(async () => (await sent(page, "merge")).length).toBe(1);
  await expect.poll(async () => (await sent(page, "releaseNotes")).length).toBe(1);
});

test("a narrow Repositories pane keeps its notes on screen", async ({ page }) => {
  await open(page, { pair: "several", width: 700 });
  const pane = await page.locator("#repos").boundingBox();
  for (const note of await page.locator(".crepo .row-note").all()) {
    const b = await note.boundingBox();
    expect(b.x + b.width).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
  }
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`${theme}: Compare renders without console errors`, async ({ page }) => {
    const errors = await open(page, { theme, pair: "several" });
    await expect(page.locator(".row-note.conflict svg")).toHaveCount(2);
    expect(errors).toEqual([]);
  });
}
