// The Repo List redraws only the rows whose look changed (repoPane.ts keeps each row's element by
// its key): the cursor, a repository opened, a box ticked. 68 repositories (dev/harness/mock.ts "many").
import { expect, test } from "@playwright/test";

const open = async (page) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => sessionStorage.setItem("linyra-layout", JSON.stringify({ repoPaneWidth: 320 })));
  await page.goto("/?theme=dark&state=many&avatars=off");
  await expect(page.locator("#repo-rows .repo-row").nth(60)).toBeAttached();
  return errors;
};
const repoRow = (page, name) => page.locator("#repo-rows .repo-row").filter({ has: page.locator(`.repo-name[data-name="${name}"]`) });
/** Tags every row element; returns how many of the tagged ones are still in the list. */
const tag = (page) => page.evaluate(() => document.querySelectorAll("#repo-rows .repo-row").forEach((el) => { el.dataset.kept = "1"; }));
const kept = (page) => page.locator('#repo-rows .repo-row[data-kept="1"]').count();

test("the cursor moves without redrawing a row", async ({ page }) => {
  const errors = await open(page);
  const total = await page.locator("#repo-rows .repo-row").count();
  await tag(page);
  await page.locator("#repo-rows").focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  expect(await kept(page), "every row kept its element").toBe(total);
  const active = page.locator("#repo-rows .repo-row.active");
  await expect(active).toHaveCount(1);
  await expect(page.locator("#repo-rows")).toHaveAttribute("aria-activedescendant", await active.getAttribute("id"));
  expect(await active.getAttribute("data-row")).toBe("3");
  expect(errors).toEqual([]);
});

test("opening a repository redraws its row alone and inserts its branches; the rows below renumber", async ({ page }) => {
  const errors = await open(page);
  const total = await page.locator("#repo-rows .repo-row").count();
  await tag(page);
  const libs = repoRow(page, "acme-libs");
  const below = repoRow(page, "acme-svc-01");
  const before = Number(await below.getAttribute("data-row"));
  await libs.locator(".tree-twisty").click();
  await expect(page.locator("#repo-rows .branch-row").first()).toBeVisible();
  await expect(libs).toHaveAttribute("aria-expanded", "true");
  await expect(libs).not.toHaveAttribute("data-kept", "1");
  expect(await kept(page), "every other repository kept its element").toBe(total - 1);
  const added = await page.locator("#repo-rows .repo-row:not([data-kept])").count();
  expect(Number(await below.getAttribute("data-row"))).toBe(before + added - 1);
  // A click lands on the row its index names.
  await below.click();
  await expect(below).toHaveClass(/active/);
  expect(errors).toEqual([]);
});

test("a box clicked on a kept row tells the truth: ticked exactly when the Log shows that repository", async ({ page }) => {
  await open(page);
  const web = repoRow(page, "acme-web");
  const box = web.locator("vscode-checkbox");
  // Untick, tick again: the boxes and the rows' aria-selected agree every time.
  for (const want of [false, true]) {
    await box.click();
    await expect(web).toHaveAttribute("aria-selected", String(want));
    await expect.poll(() => box.evaluate((el) => el.checked)).toBe(want);
  }
  const disagree = await page.evaluate(() => [...document.querySelectorAll("#repo-rows .repo-row:has(vscode-checkbox)")]
    .filter((row) => row.querySelector("vscode-checkbox").checked !== (row.getAttribute("aria-selected") === "true")).length);
  expect(disagree).toBe(0);
});
