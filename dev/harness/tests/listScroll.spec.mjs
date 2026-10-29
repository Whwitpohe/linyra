// The Log keeps its scroll position as it last set or read it (list.ts: holding ↓ lays the page out
// once a frame). These are the ways that kept position could part from the real one and leave the
// Log blank: a selection revealed before the taller list is laid out, and a scroll set while hidden.
import { expect, test } from "@playwright/test";

const open = async (page, { height = 400 } = {}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1400, height });
  await page.goto("/?theme=dark&state=default&avatars=off&date=all");
  await expect(page.locator("#rows .row").first()).toBeVisible();
  return errors;
};
const selectedSha = (page) => page.evaluate(() => window.harnessMessages.filter((m) => m.type === "select").at(-1)?.sha);
/** Every row the list shows lies on screen, and the screen is not left empty. */
const filled = (page) => expect.poll(() => page.locator("#list").evaluate((list) => {
  const box = list.getBoundingClientRect();
  return [...list.querySelectorAll("#rows .row[data-index]")].map((r) => r.getBoundingClientRect()).filter((r) => r.bottom > box.top && r.top < box.bottom).length;
})).toBeGreaterThan(5);

test("a selection kept when the search is cleared is shown, though the list it lands in is longer", async ({ page }) => {
  const errors = await open(page);
  const list = page.locator("#list");
  await list.evaluate((el) => { el.scrollTop = 60 * el.querySelector("#rows .row").offsetHeight; });
  const index = 64;
  const first = await selectedSha(page);
  await page.locator(`#rows .row[data-index="${index}"]`).click();
  await expect.poll(() => selectedSha(page)).not.toBe(first);
  const sha = await selectedSha(page);
  await page.fill("#search", sha.slice(0, 10));
  await expect(page.locator("#rows .row[data-index]")).toHaveCount(1);
  await page.fill("#search", "");
  const row = page.locator(`#rows .row[data-index="${index}"]`);
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(row).toBeInViewport();
  await filled(page);
  // The wheel scrolls on from where the list really is, not from a position it meant to set.
  await page.keyboard.press("Escape");
  await expect(page.locator("#search-suggestions")).toBeHidden();
  await list.hover();
  await page.mouse.wheel(0, 120);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await filled(page);
  expect(errors).toEqual([]);
});

test("a position set while the Log is hidden holds once it shows again", async ({ page }) => {
  const errors = await open(page);
  const list = page.locator("#list");
  await list.evaluate((el) => { el.scrollTop = 40 * el.querySelector("#rows .row").offsetHeight; });
  await expect(page.locator(`#rows .row[data-index="45"]`)).toBeAttached();
  // Hidden (another view in its place), then moved by the keyboard, then shown.
  await list.evaluate((el) => { el.style.display = "none"; });
  await page.keyboard.press("Escape");
  await list.evaluate((el) => { el.focus(); el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
  await list.evaluate((el) => { el.style.display = ""; });
  await filled(page);
  await list.hover();
  await page.mouse.wheel(0, 240);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await filled(page);
  expect(errors).toEqual([]);
});
