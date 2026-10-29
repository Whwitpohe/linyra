// Compare's toolbar and empty sides against the dev harness: Merge is a labeled button with ▶'s real
// name after the branch boxes, the toggles keep their names (aria-pressed says on or off), the layout
// buttons say what they lay out, and an empty side offers its way back as a link. Every theme, and narrow.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", query = "", width = 1400, height = 420, locale = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/repos${locale ? `.${locale}` : ""}.html?theme=${theme}${query}`);
  await expect(page.locator("#repo-list .crepo").first()).toBeVisible();
  return errors;
};
const sent = (page, type) => page.evaluate((t) => window.compareMessages.filter((m) => m.type === t), type);

test("Merge is a labeled button after the branch boxes, with the branch it goes into", async ({ page }) => {
  await open(page);
  const merge = page.locator("#compare-merge");
  await expect(merge).toHaveText("Merge into origin/main…");
  await expect(merge).toBeEnabled();
  // Right after ▶ in the pair, not among the toggles.
  expect(await page.locator(".cbar-pair > :last-child").getAttribute("id")).toBe("compare-merge");
  await expect(page.locator(".cbar-show #compare-merge")).toHaveCount(0);
  await merge.click();
  await expect.poll(async () => (await sent(page, "merge")).length).toBe(1);
  // Several names on ▶: each of them.
  await open(page, { query: "&pair=several" });
  await expect(page.locator("#compare-merge")).toHaveText("Merge into main, master…");
  // The same branch on both sides: nothing to merge yet.
  await page.evaluate(() => window.postMessage({ type: "state", pair: { left: "origin/main", right: "origin/main" }, mode: "files", recent: [], favorites: [] }, "*"));
  await expect(page.locator("#compare-merge")).toBeDisabled();
  await expect(page.locator("#compare-merge")).toHaveText("Merge…");
});

test("the toggles keep their names; aria-pressed says whether each is on", async ({ page }) => {
  await open(page);
  const hide = page.locator("#compare-hide-same");
  await expect(hide).toHaveAttribute("aria-label", "Hide Files Already on Both");
  await expect(hide).toHaveAttribute("title", "Hide Files Already on Both");
  await expect(hide).toHaveAttribute("aria-pressed", "true");
  await hide.click();
  await expect(hide).toHaveAttribute("aria-pressed", "false");
  await expect(hide).toHaveAttribute("aria-label", "Hide Files Already on Both", { timeout: 2000 });
  const only = page.locator("#compare-only-conflicts");
  await expect(only).toHaveAttribute("aria-label", "Show Only Conflicts");
  await only.click();
  await expect(only).toHaveAttribute("aria-pressed", "true");
  await expect(only).toHaveAttribute("aria-label", "Show Only Conflicts");
  // The layout buttons say what they lay out (not the Log's "Side-by-side Layout").
  await expect(page.locator("#compare-layout-horizontal")).toHaveAttribute("aria-label", "Left and Right Side by Side");
  await expect(page.locator("#compare-layout-stacked")).toHaveAttribute("aria-label", "Left Above Right");
});

test("in Chinese, the layout buttons read 左右排列 / 上下排列 and Merge names the branch", async ({ page }) => {
  await open(page, { locale: "zh-cn" });
  await expect(page.locator("#compare-layout-horizontal")).toHaveAttribute("title", "左右排列");
  await expect(page.locator("#compare-layout-stacked")).toHaveAttribute("title", "上下排列");
  await expect(page.locator("#compare-merge")).toHaveText("合并到 origin/main…");
});

test("a side whose files are all on both says so and links back: Show 3 files already on both", async ({ page }) => {
  await open(page, { query: "&empty=same" });
  await expect(page.locator("#compare-left-message")).toHaveText("Every file this side changed is already on both branches.");
  const link = page.locator("#compare-left-empty-link");
  await expect(link).toHaveText("Show 3 files already on both");
  await expect(page.locator("#compare-left-message")).not.toContainText("title bar");
  await link.click();
  await expect.poll(async () => (await sent(page, "hideSame")).at(-1)).toEqual({ type: "hideSame", hide: false });
  await expect(page.locator("#compare-left-empty-action")).toBeHidden();
  await expect(page.locator("#compare-left-tree .compare-tree-row", { hasText: "retry.go" })).toBeVisible();
  await expect(page.locator("#compare-hide-same")).toHaveAttribute("aria-pressed", "false");
});

test("Only Conflicts with none on a side: said, with a link to every file", async ({ page }) => {
  await open(page, { query: "&empty=conflicts" });
  await page.locator("#compare-only-conflicts").click();
  await expect(page.locator("#compare-left-message")).toHaveText("No file on this side would conflict.");
  await page.locator("#compare-left-empty-link").click();
  await expect.poll(async () => (await sent(page, "onlyConflicts")).at(-1)).toEqual({ type: "onlyConflicts", on: false });
  await expect(page.locator("#compare-left-empty-action")).toBeHidden();
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`${theme}, narrow: the toolbar wraps without scrolling sideways; Merge, its link and focus are visible`, async ({ page }) => {
    const errors = await open(page, { theme, width: 420, height: 640, query: "&empty=same" });
    const overflow = await page.evaluate(() => document.querySelector(".cbar").scrollWidth - document.querySelector(".cbar").clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const merge = page.locator("#compare-merge");
    await expect(merge).toBeVisible();
    const box = await merge.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(420);
    // Theme colors, not the browser's: the secondary button's own background.
    const bg = await merge.evaluate((b) => getComputedStyle(b).backgroundColor);
    const want = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--vscode-button-secondaryBackground").trim());
    if (want) expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    await merge.focus();
    const outline = await merge.evaluate((b) => getComputedStyle(b).outlineStyle);
    expect(outline).not.toBe("none");
    await expect(page.locator("#compare-left-empty-link")).toBeVisible();
    await page.screenshot({ path: `test-results/compare-toolbar-${theme}.png` });
    expect(errors).toEqual([]);
  });
}
