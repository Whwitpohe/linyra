// Branch pills in Log rows and the commit hover card (plan section 3.C), against the harness's
// mock rows (dev/harness/mock/hover.ts): acme-web's newest commit is HEAD on develop with
// origin/develop and a tag, acme-api's is develop 3 behind its upstream, acme-libs' a detached HEAD.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 1500, height = 520, query = "", locale = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/${locale ? `index.${locale}.html` : ""}?theme=${theme}&state=default&avatars=off${query}`);
  await expect(page.locator("#rows .row").first()).toBeVisible();
  return errors;
};
const row = (page, i) => page.locator(`#rows .row[data-index="${i}"]`);
const messages = (page, prefix = "hover") => page.evaluate((p) => window.harnessMessages.filter((m) => m.type.startsWith(p)), prefix);
const card = (page) => page.locator("#hover-card");
/** Rests the pointer on a row's subject (the card opens after 500 ms). */
const rest = async (page, i, part = ".subject") => {
  const b = await row(page, i).locator(part).first().boundingBox();
  await page.mouse.move(b.x + Math.min(20, b.width / 2), b.y + b.height / 2);
};
const contextOf = (locator) => locator.getAttribute("data-vscode-context").then((v) => (v === null ? null : JSON.parse(v)));

test("a checked-out branch and its same-name remote share one pill; tags apart; HEAD only when detached", async ({ page }) => {
  await open(page);
  const web = row(page, 0).locator(".row-refs .pill");
  await expect(web).toHaveCount(2);
  await expect(web.nth(0)).toHaveClass(/pill-current/);
  await expect(web.nth(0).locator(".pill-part")).toHaveText(["develop", "origin"]);
  await expect(web.nth(1)).toHaveClass(/pill-tag/);
  await expect(web.nth(1)).toHaveText("v1.4.0");
  // acme-api's develop is 3 behind its upstream (the harness's sync message).
  await expect(row(page, 1).locator(".pill-current .pill-status")).toHaveText("↓3");
  // acme-libs: HEAD detached at a tag.
  const libs = row(page, 2).locator(".row-refs .pill");
  await expect(libs.nth(0)).toHaveClass(/pill-detached/);
  await expect(libs.nth(0)).toHaveText("HEAD");
  await expect(row(page, 5).locator(".row-refs .pill")).toHaveCount(1, { timeout: 1000 });
  await expect(row(page, 5).locator(".pill-current")).toHaveCount(0);
  // The old one-label badges are gone.
  await expect(page.locator("#rows .row-ref-label")).toHaveCount(0);
});

test("pills that do not fit become +N; the hidden ones stay out of the way", async ({ page }) => {
  await open(page, { width: 1300 });
  const refs = row(page, 6).locator(".row-refs");
  const more = refs.locator(".row-ref-more");
  await expect(more).toBeVisible();
  const hidden = await refs.locator(".pill[hidden]").count();
  expect(hidden).toBeGreaterThan(0);
  await expect(more).toHaveText(`+${hidden}`);
  const box = await refs.boundingBox();
  for (const pill of await refs.locator(".pill:not([hidden])").all()) {
    const b = await pill.boundingBox();
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
  }
});

test("a pill's right-click carries the refPill context, and package.json offers the Repo List's branch commands there", async ({ page }) => {
  await open(page);
  const pills = row(page, 0).locator(".row-refs .pill");
  expect(await contextOf(pills.nth(0))).toEqual({ preventDefaultContextMenuItems: true, webviewSection: "refPill", repoId: "/work/acme-web", ref: "refs/heads/develop", kind: "local", current: true });
  expect(await contextOf(pills.nth(1))).toEqual({ preventDefaultContextMenuItems: true, webviewSection: "refPill", repoId: "/work/acme-web", ref: "refs/tags/v1.4.0", kind: "tag", current: false });
  expect(await contextOf(row(page, 6).locator(".row-refs > .pill").nth(0))).toMatchObject({ kind: "local", ref: "refs/heads/master", current: false });
  expect(await contextOf(row(page, 6).locator(".row-refs > .pill").nth(1))).toMatchObject({ kind: "remote", ref: "refs/remotes/origin/release-1.4" });
  // A detached HEAD has no branch menu: the row's commit menu shows.
  expect(await contextOf(row(page, 2).locator(".row-refs > .pill.pill-detached"))).toBeNull();
  const menus = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).contributes.menus["webview/context"];
  // The Repo List's branch commands, all of them (AI's explain/review items join them).
  const onPill = menus.filter((m) => m.when.includes("webviewSection == 'refPill'")).map((m) => m.command).filter((c) => c.startsWith("linyra.branch.")).sort();
  expect(onPill).toEqual(["linyra.branch.checkout", "linyra.branch.compare", "linyra.branch.copy", "linyra.branch.merge", "linyra.branch.pull", "linyra.branch.push", "linyra.branch.rebase"]);
});

test("clicking a pill opens its branch's sheet; the sheet's Reveal shows it in the Repo List", async ({ page }) => {
  await open(page);
  const sheetName = page.locator("#branch-sheet .sheet-name");
  const reveal = () => page.locator('#branch-sheet button[data-action="reveal"]').click();
  await row(page, 6).locator(".row-refs > .pill").first().locator(".pill-local").click();
  await expect(sheetName).toHaveText("master");
  // The row was selected as by any click.
  await expect(row(page, 6)).toHaveAttribute("aria-selected", "true");
  await reveal();
  const active = page.locator("#repo-rows .repo-row.active");
  await expect(active).toHaveClass(/branch-row/);
  await expect(active.locator(".branch-name")).toHaveText("master");
  await expect(page.locator("#repo-rows")).toBeFocused();
  // A remote branch opens its repository's Remote group and its remote's row too (acme-api's origin/master).
  await row(page, 10).locator(".row-refs > .pill").click();
  await expect(sheetName).toHaveText("origin/master");
  await reveal();
  await expect(page.locator("#repo-rows .repo-row.active .branch-name")).toHaveText("master");
  await expect(page.locator("#repo-rows .repo-row.active")).toHaveAttribute("aria-level", "4");
  // Each part of a joined pill is its own: develop's part shows develop, its remote part origin/develop.
  await row(page, 0).locator(".pill-current .pill-local").click();
  await expect(sheetName).toHaveText("develop");
  await reveal();
  await expect(page.locator("#repo-rows .repo-row.active .branch-name")).toHaveText("develop");
  await expect(page.locator("#repo-rows .repo-row.active")).toHaveAttribute("aria-level", "3");
  await row(page, 0).locator(".pill-current .pill-remote").click();
  await expect(sheetName).toHaveText("origin/develop");
  await reveal();
  await expect(page.locator("#repo-rows .repo-row.active .branch-name")).toHaveText("develop");
  await expect(page.locator("#repo-rows .repo-row.active")).toHaveAttribute("aria-level", "4");
});

test("the card opens after the pointer rests 500 ms: the row's data at once, then one git show's", async ({ page }) => {
  await open(page, { query: "&hoverDelay=400" });
  await rest(page, 0);
  await page.waitForTimeout(300);
  await expect(card(page)).toBeHidden();
  expect(await messages(page)).toEqual([]);
  await expect(card(page)).toBeVisible();
  // At once, from the row.
  // The harness's "me" is dana in every repository (shim.ts), so her commit reads as mine.
  await expect(card(page).locator(".hover-author")).toHaveText("You");
  await expect(card(page).locator(".hover-when")).toHaveText(/^just now \(\d{4}-\d\d-\d\d \d\d:\d\d\)$/);
  await expect(card(page).locator(".hover-repo")).toHaveText("acme-web");
  await expect(card(page).locator(".hover-subject")).toHaveText("feat: add retry to uploader");
  await expect(card(page).locator(".hover-refs .pill")).toHaveCount(2);
  await expect(card(page).locator(".author-disc-html")).toHaveText("D");
  await expect(card(page).locator(".hover-loading")).toBeVisible();
  const sha = await page.evaluate(() => window.harnessMessages.find((m) => m.type === "hover").sha);
  await expect(card(page).locator(".hover-hash")).toHaveText(sha.slice(0, 8));
  // Then the host's git show: the body, files by kind, lines; and the HEAD row's merge target.
  await expect(card(page).locator(".hover-body")).toContainText("Keep the upload preview in step");
  await expect(card(page).locator(".hover-loading")).toHaveCount(0);
  await expect(card(page).locator(".hover-stats")).toContainText("5 files changed");
  await expect(card(page).locator(".hover-stats .counts")).toHaveAttribute("aria-label", "1 new, 3 modified, 1 deleted");
  await expect(card(page).locator(".hover-stats .line-counts")).toHaveText("+42−7");
  await expect(card(page).locator(".hover-target")).toContainText("Merge target origin/main · 2 ahead");
  await expect(card(page).locator(".hover-actions .hover-link")).toHaveText(["Copy Hash", "Open on Remote", "Explain"]);
  expect((await messages(page)).map((m) => m.type)).toEqual(["hover"]);
});

test("a pointer passing over rows opens nothing and starts no read", async ({ page }) => {
  await open(page);
  for (let i = 0; i < 6; i++) { await rest(page, i); await page.waitForTimeout(120); }
  await page.mouse.move(5, 500);
  await page.waitForTimeout(700);
  await expect(card(page)).toBeHidden();
  expect(await messages(page)).toEqual([]);
});

test("leaving the row closes the card and kills its read; another row opens its own", async ({ page }) => {
  await open(page, { query: "&hoverDelay=1500" });
  await rest(page, 3, ".author");
  await expect(card(page)).toBeVisible();
  await page.mouse.move(5, 500);
  await expect(card(page)).toBeHidden();
  expect((await messages(page)).map((m) => m.type)).toEqual(["hover", "hoverEnd"]);
  await page.waitForTimeout(1600);
  await expect(card(page)).toBeHidden();
  // A row without branches (not HEAD): no merge target.
  await rest(page, 4, ".date");
  await expect(card(page).locator(".hover-stats")).toBeVisible({ timeout: 3000 });
  await expect(card(page).locator(".hover-target")).toHaveCount(0);
  await expect(card(page).locator(".hover-refs")).toHaveCount(0);
});

test("the pointer can move into the card; it never takes focus; a key or a scroll closes it", async ({ page }) => {
  await open(page);
  await row(page, 1).locator(".subject").click();
  await expect(page.locator("#list")).toBeFocused();
  await rest(page, 0);
  await expect(card(page).locator(".hover-stats")).toBeVisible();
  const link = card(page).locator(".hover-actions .hover-link").first();
  const b = await link.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
  await page.waitForTimeout(400);
  await expect(card(page)).toBeVisible();
  await page.mouse.down();
  await page.mouse.up();
  await expect(card(page).locator(".hover-hash")).toHaveText("Copied");
  await expect(page.locator("#list")).toBeFocused();
  expect((await messages(page, "hoverAction")).map((m) => m.action)).toEqual(["copySha"]);
  await page.keyboard.press("Escape");
  await expect(card(page)).toBeHidden();
  // Scrolling the Log closes it too.
  await rest(page, 2);
  await expect(card(page)).toBeVisible();
  await page.mouse.wheel(0, 120);
  await expect(card(page)).toBeHidden();
  expect((await messages(page)).filter((m) => m.type === "hoverEnd").length).toBe(2);
});

test("no Explain link without the AI command; the card replaces the row's own tooltips", async ({ page }) => {
  await open(page, { query: "&explain=off" });
  await rest(page, 0, "[data-graph-node]");
  await expect(card(page).locator(".hover-stats")).toBeVisible();
  await expect(card(page).locator(".hover-actions .hover-link")).toHaveText(["Copy Hash", "Open on Remote"]);
  for (const part of [".subject", ".date", ".author", ".row-refs", ".row-ref-more"]) await expect(row(page, 0).locator(part)).not.toHaveAttribute("title", /./);
  await expect(row(page, 0).locator(".graph-point > title")).toHaveCount(0);
});

test("zh-cn: the card speaks Chinese", async ({ page }) => {
  await open(page, { locale: "zh-cn" });
  await rest(page, 0);
  await expect(card(page).locator(".hover-target")).toContainText("合并目标 origin/main · 领先 2 个提交");
  await expect(card(page).locator(".hover-stats")).toContainText("5 个文件已更改");
  await expect(card(page).locator(".hover-actions .hover-link")).toHaveText(["复制哈希", "在远程打开", "解释"]);
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`${theme}: pills and the card render without console errors`, async ({ page }) => {
    const errors = await open(page, { theme });
    await rest(page, 0);
    await expect(card(page).locator(".hover-stats")).toBeVisible();
    const style = await card(page).evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, border: s.borderTopStyle }; });
    expect(style.bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(style.border).toBe("solid");
    expect(errors).toEqual([]);
  });
}
