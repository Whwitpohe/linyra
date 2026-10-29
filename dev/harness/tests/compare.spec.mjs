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

test("a side ticks several branches: each has its place in the order, ∧ ∨ move it, the box shows them in order", async ({ page }) => {
  await open(page);
  await page.locator("#branch-left").click();
  await expect(page.locator("#picker")).toBeVisible();
  // Default branch: each repository's origin/HEAD.
  await expect(page.locator(".picker-group", { hasText: "Default branch" })).toBeVisible();
  const row = (name) => page.locator(".picker-row.name").filter({ has: page.getByText(name, { exact: true }) }).first();
  await expect(row("origin/release-1.4").locator(".picker-order")).toHaveText("1");
  await expect(row("origin/release-1.3").locator(".picker-order")).toHaveText("–");
  // A click ticks it, second; the picker stays open.
  await row("origin/release-1.3").click();
  await expect(page.locator("#name-left")).toHaveText("origin/release-1.4, origin/release-1.3");
  await expect.poll(async () => (await sent(page, "pick")).at(-1)?.pair).toEqual({ left: "origin/release-1.4 origin/release-1.3", right: "origin/main" });
  await expect(row("origin/release-1.3").locator(".picker-order")).toHaveText("2");
  await expect(row("origin/release-1.3")).toHaveAttribute("aria-checked", "true");
  // ∧ moves it first.
  await row("origin/release-1.3").locator('.picker-move[data-move="-1"]').click();
  await expect(page.locator("#name-left")).toHaveText("origin/release-1.3, origin/release-1.4");
  await expect(row("origin/release-1.3").locator(".picker-order")).toHaveText("1");
  // A click on a ticked one unticks it.
  await row("origin/release-1.4").click();
  await expect(page.locator("#name-left")).toHaveText("origin/release-1.3");
  await expect(page.locator("#picker")).toBeVisible();
  await page.locator("#picker-search").press("Escape");
  await expect(page.locator("#picker")).toBeHidden();
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
  await expect(page.locator("#compare-left-tree .ftree-row", { hasText: "acme-api" })).toBeVisible();
  await expect(page.locator("#compare-left-tree .ftree-row.conflict").first()).toBeVisible();
});

test("Repositories look like the Repo List: a box per row; the box or Ctrl-click ticks one, a click shows only it", async ({ page }) => {
  await open(page);
  const repo = (id) => page.locator(`.crepo[data-repo="${id}"]`);
  const ticked = page.locator('.crepo:not(.all)[aria-selected="true"]');
  // The same box as the Log's Repo List, on every row and on All repositories.
  await expect(page.locator(".crepo vscode-checkbox.repo-check")).toHaveCount(5);
  await repo("/work/acme-api").click();
  await expect(ticked).toHaveCount(1);
  await expect(repo("/work/acme-web").locator(".repo-name")).toHaveCSS("color", await page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--vscode-descriptionForeground").trim().replace(/^#(..)(..)(..)$/, (_, r, g, b) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`)));
  // Its box ticks one more; the sides show both, together.
  await repo("/work/acme-libs").locator(".repo-check").click();
  await expect(ticked).toHaveCount(2);
  await expect.poll(async () => (await sent(page, "select")).at(-1)?.repoId).toBe("+/work/acme-api\n/work/acme-libs");
  await expect(page.locator("#compare-left-tree .ftree-row", { hasText: "acme-libs" })).toBeVisible();
  // Some ticked, not all: All repositories shows a dash.
  await expect(repo("*").locator(".repo-check")).toHaveJSProperty("indeterminate", true);
  // Ctrl-click the last one: every repository whose files differ, so All repositories.
  await repo("/work/acme-web").click({ modifiers: ["Control"] });
  await expect.poll(async () => (await sent(page, "select")).at(-1)?.repoId).toBe("*");
  await expect(repo("*").locator(".repo-check")).toHaveJSProperty("checked", true);
  // Shift-click picks rows, not their text.
  await repo("/work/acme-api").click();
  await repo("/work/acme-web").click({ modifiers: ["Shift"] });
  await expect(ticked).toHaveCount(2);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  // A plain click: only that one.
  await repo("/work/acme-libs").click();
  await expect(ticked).toHaveCount(1);
});

test("a side's filter keeps matching rows and their folders; Ctrl/Shift-click selects several", async ({ page }) => {
  await open(page);
  const rows = page.locator("#compare-left-tree .ftree-row");
  await expect(rows).toHaveCount(3);
  await page.locator("#compare-left-filter").fill("upload");
  await expect(rows).toHaveText([/src/, /upload\.ts/]);
  await page.locator("#compare-left-filter").press("Escape");
  await expect(rows).toHaveCount(3);
  await rows.nth(1).click();
  await rows.nth(2).click({ modifiers: ["Control"] });
  await expect(page.locator("#compare-left-tree .ftree-row.selected")).toHaveCount(2);
  await expect.poll(async () => (await sent(page, "sideSelect")).at(-1)?.ids.length).toBe(2);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("Only Conflicts lists only the conflicted files, says how many and looks pressed; Merge and Release Notes reach the host", async ({ page }) => {
  await open(page);
  const button = page.locator("#compare-only-conflicts");
  await expect(button).toBeEnabled();
  await expect(button.locator(".button-count")).toHaveText("1");
  const look = () => button.evaluate((b) => getComputedStyle(b).backgroundColor);
  const off = await look();
  await button.click();
  await expect.poll(look).not.toBe(off);
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#compare-left-tree .ftree-row", { hasText: ".ts" })).toHaveText([/limits\.ts/]);
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
    // "Merges cleanly" is a circled check: it must not read as a checkbox.
    await expect(page.locator(".row-note.clean svg")).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}
