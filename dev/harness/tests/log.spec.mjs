// The Log webview's layout contract, as checked by hand while designing it: one header row when the
// Log is wide, two when it is not; nothing in the Repositories pane spills into the Log; the ⋯ menu
// stays on screen in a short panel; every theme renders VS Code's icons without console errors.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 1600, height = 400 } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/?theme=${theme}&state=default`);
  await expect(page.locator("#rows .row").first()).toBeVisible();
  return errors;
};
const box = (page, selector) => page.locator(selector).first().boundingBox();

test("a wide Log keeps its header on one row", async ({ page }) => {
  await open(page, { width: 1900, height: 320 });
  const header = await box(page, "#log-header");
  expect(header.height).toBeLessThan(44);
  const tops = await page.locator("#log-header > *:visible").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(6);
});

test("a narrower Log wraps the header to two rows: switch and actions, then the filters", async ({ page }) => {
  await open(page, { width: 1400, height: 320 });
  const header = await box(page, "#log-header");
  expect(header.height).toBeLessThan(76);
  const actions = await box(page, ".header-actions");
  const filters = await box(page, "#filters");
  expect(filters.y).toBeGreaterThan(actions.y + actions.height - 2);
});

test("the switch is as tall as the inputs beside it, and every dropdown has the same arrow", async ({ page }) => {
  await open(page);
  expect((await box(page, ".switch")).height).toBe((await box(page, "#search")).height);
  const arrows = await page.locator("#log-header .chevron").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
  expect(arrows.length).toBe(3);
  expect(new Set(arrows).size).toBe(1);
});

test("nothing in the Repositories pane spills into the Log, opened or closed", async ({ page }) => {
  await open(page);
  const pane = await box(page, "#repo-pane");
  await page.click("#repo-expand-all");
  await expect(page.locator("#repo-rows .branch-row").first()).toBeVisible();
  for (const selector of ["#repo-expand-all", "#repo-collapse-all", "#repo-rows .repo-row", "#repo-rows .repo-sync"]) {
    const rights = await page.locator(selector).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
    for (const right of rights) expect(right).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
  }
  await page.click("#repo-collapse-all");
  await expect(page.locator("#repo-rows .branch-row")).toHaveCount(0);
});

test("the ⋯ menu stays on screen in a short panel and holds the view options", async ({ page }) => {
  await open(page, { height: 320 });
  await page.click("#toolbar-more");
  const menu = page.locator("#toolbar-menu");
  await expect(menu).toBeVisible();
  const b = await menu.boundingBox();
  expect(b.y).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height).toBeLessThanOrEqual(320);
  await expect(menu.getByRole("menuitemcheckbox", { name: "Show Hash Column" })).toBeVisible();
  await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
  await menu.getByRole("menuitemcheckbox", { name: "Show Hash Column" }).click();
  await expect(page.locator("#rows .row .hash").first()).toBeVisible();
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`${theme}: VS Code's icons render and the page logs no errors`, async ({ page }) => {
    const errors = await open(page, { theme });
    expect(await page.locator("svg.codicon").count()).toBeGreaterThan(15);
    for (const id of ["toolbar-more", "toolbar-fetch", "refresh", "match-case", "use-regex", "repo-expand-all"]) {
      await expect(page.locator(`#${id} svg.codicon`)).toHaveCount(1);
    }
    expect(errors).toEqual([]);
  });
}
