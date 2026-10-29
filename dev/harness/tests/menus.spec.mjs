// The popup menus (ui/menu.ts) and the keyboard: where the focus starts, that a menu built again
// while open (its state changed) keeps it, and where it goes when the menu closes.
import { expect, test } from "@playwright/test";

const open = async (page) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1500, height: 700 });
  await page.goto("/?theme=dark&state=default&avatars=off");
  await expect(page.locator("#rows .row").first()).toBeVisible();
  return errors;
};
const focusedText = (page) => page.evaluate(() => document.activeElement?.textContent ?? "");

test("⋯ opens on its first action, not on a choice further down", async ({ page }) => {
  const errors = await open(page);
  await page.click("#toolbar-more");
  await expect(page.getByRole("menuitem", { name: "Branches Across Repositories…" })).toBeFocused();
  expect(errors).toEqual([]);
});

test("a menu built again while open (a fetch ended) keeps the focus on the same item", async ({ page }) => {
  const errors = await open(page);
  await page.click("#toolbar-more");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  expect(await focusedText(page)).toBe("Run Git Command Across Repositories…");
  const before = await page.locator("#toolbar-menu").elementHandle();
  await page.evaluate(() => window.postMessage({ type: "toolbar", state: { groupByRepo: true, compareShown: false, fetching: true, anyBehind: true } }, "*"));
  // Built anew (the old element is gone), the focus where it was.
  await expect.poll(() => before.evaluate((el) => el.isConnected)).toBe(false);
  await expect(page.locator("#toolbar-menu")).toBeVisible();
  expect(await focusedText(page)).toBe("Run Git Command Across Repositories…");
  expect(errors).toEqual([]);
});

test("Tab closes a menu and moves on from the button that opened it", async ({ page }) => {
  const errors = await open(page);
  await page.click("#toolbar-more");
  await expect(page.locator("#toolbar-menu")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator("#toolbar-menu")).toBeHidden();
  const after = await page.evaluate(() => {
    const active = document.activeElement, more = document.getElementById("toolbar-more");
    return { body: active === document.body, following: Boolean(more.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  expect(after).toEqual({ body: false, following: true });
  expect(errors).toEqual([]);
});

test("Shift+F10 on a column's button opens Columns; Esc goes back to that button", async ({ page }) => {
  const errors = await open(page);
  const date = page.locator(".column-header .column-date .column-button");
  await date.focus();
  await page.keyboard.press("Shift+F10");
  const columns = page.getByRole("menu", { name: "Columns" });
  await expect(columns).toBeVisible();
  // A menu of checkboxes is not a choice: its first item has the focus.
  await expect(columns.getByRole("menuitemcheckbox").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(columns).toBeHidden();
  await expect(date).toBeFocused();
  // Right-click (no button opened it): the focus goes back to what had it.
  await page.locator("#list").focus();
  await page.locator(".column-header").click({ button: "right" });
  await expect(columns).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#list")).toBeFocused();
  expect(errors).toEqual([]);
});
