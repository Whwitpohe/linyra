// Every popup closes on a click outside it, wherever that is (src/webview/ui/dismiss.ts): in the page,
// even where a part of it handles the click itself, and elsewhere in VS Code, which the page sees
// only as its window losing focus. The branch and author filters, the toolbar's ⋯ menu, the
// changed files' ⋯ menu, a question (ui/prompt.ts), and Compare's branch picker.
import { expect, test } from "@playwright/test";

const open = async (page, path = "/?theme=dark&state=default&avatars=off") => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1300, height: 640 });
  await page.goto(path);
  return errors;
};
/**
 * A click on a point of an element that the open popup does not cover (its corners, its middle,
 * whichever is free): a click outside the popup, whatever its size at this width.
 */
const clickOutside = async (page, selector, popup) => {
  const point = await page.evaluate(([sel, pop]) => {
    const el = document.querySelector(sel), open = document.querySelector(pop);
    const r = el.getBoundingClientRect();
    const points = [[r.right - 6, r.bottom - 6], [r.left + 6, r.bottom - 6], [r.left + r.width / 2, r.top + r.height / 2], [r.right - 6, r.top + 6], [r.left + 6, r.top + 6]];
    return points.find(([x, y]) => { const hit = document.elementFromPoint(x, y); return hit && el.contains(hit) && !open?.contains(hit); }) ?? null;
  }, [selector, popup]);
  if (!point) return false; // wholly under the popup at this width
  await page.mouse.click(point[0], point[1]);
  return true;
};
/** A click elsewhere in VS Code: the webview's window loses focus, and its page sees nothing else. */
const leave = (page) => page.evaluate(() => window.dispatchEvent(new Event("blur")));

const LOG = [
  { name: "the branch filter", open: "#branch", popup: "#branch-picker" },
  { name: "the author filter", open: "#author", popup: "#author-picker" },
  { name: "the toolbar's ⋯ menu", open: "#toolbar-more", popup: ".popup-menu" },
  { name: "the changed files' ⋯ menu", open: "#changes-more", popup: "#changes-actions" },
  { name: "a question (Update Project)", open: "#toolbar-update", popup: ".prompt" },
];
// Places outside every popup: the Repo List, the column header, a commit row, the changed files, the footer, the search box.
const OUTSIDE = ["#repo-rows", ".column-header .column-head[data-column='message']", "#rows .row[data-index='5'] .subject", "#file-tree", ".footer", "#search"];

for (const p of LOG) {
  test(`${p.name} closes on a click elsewhere in VS Code and on a click anywhere outside it in the page`, async ({ page }) => {
    const errors = await open(page);
    await expect(page.locator("#rows .row").first()).toBeVisible();
    const show = async () => {
      await page.locator(p.open).click();
      await expect(page.locator(p.popup)).toBeVisible();
    };
    await show();
    await leave(page);
    await expect(page.locator(p.popup)).toBeHidden();
    let clicked = 0;
    for (const where of OUTSIDE) {
      await show();
      if (!(await clickOutside(page, where, p.popup))) { await page.keyboard.press("Escape"); continue; }
      clicked++;
      await expect(page.locator(p.popup), `a click on ${where}`).toBeHidden();
    }
    // A wide popup can cover a target whole at this width (the question covers the column header and the search box).
    expect(clicked).toBeGreaterThanOrEqual(4);
    // A press on it (its own frame, not one of its items, which act and close) keeps it open.
    await show();
    await page.locator(p.popup).first().dispatchEvent("pointerdown");
    await expect(page.locator(p.popup)).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("a page hidden (another tab in front) closes the filters", async ({ page }) => {
  await open(page);
  await page.locator("#branch").click();
  await expect(page.locator("#branch-picker")).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("#branch-picker")).toBeHidden();
});

test("Compare's branch picker closes on a click elsewhere in VS Code and on a click outside it", async ({ page }) => {
  await open(page, "/repos.html?theme=dark");
  await expect(page.locator("#repo-list .crepo").first()).toBeVisible();
  await page.locator("#branch-left").click();
  await expect(page.locator("#picker")).toBeVisible();
  await leave(page);
  await expect(page.locator("#picker")).toBeHidden();
  await page.locator("#branch-left").click();
  await expect(page.locator("#picker")).toBeVisible();
  await clickOutside(page, "#repo-list", "#picker");
  await expect(page.locator("#picker")).toBeHidden();
});
