// The search box's popup, after GitLens's Commit Graph search: a help line, two-line rows with an
// icon, the operator in bold and its aliases at the right; the keyboard's row and the mouse's
// hover kept apart; it fits the panel, and typing filters its rows rather than rebuilding them.
import { expect, test } from "@playwright/test";

const open = async (page, { query = "", width = 1600, height = 520, path = "/" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`${path}?theme=dark&state=default&date=all${query}`);
  await page.evaluate(() => sessionStorage.clear());
  await expect(page.locator("#rows .row").first()).toBeVisible();
  return errors;
};
const popup = (page) => page.locator("#search-suggestions");
const hint = (page) => popup(page).locator(".suggest-hint");
const rows = (page) => popup(page).locator(".suggest-row");
const row = (page, label) => rows(page).filter({ has: page.locator(".suggest-label", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });

test("each row is two lines: an icon, the operator in bold with its aliases at the right, what it gets you below", async ({ page }) => {
  const errors = await open(page);
  await page.click("#search");
  await expect(hint(page)).toHaveText("Combine filters to build powerful searches, e.g. @me after:1.week.ago file:*.ts");
  await expect(hint(page).locator("code")).toHaveText("@me after:1.week.ago file:*.ts");
  await expect(rows(page).locator(".suggest-label")).toHaveText([
    "Search using natural language", "message:", "-message:", "author:", "committer:", "commit:", "ref:", "type:", "file:", "change:", "after:", "before:", "repo:",
  ]);
  await expect(rows(page).locator(".suggest-icon svg")).toHaveCount(13);
  await expect(row(page, "author:").locator(".suggest-aside")).toHaveText("@:");
  await expect(row(page, "commit:").locator(".suggest-aside")).toHaveText("#:, sha:");
  await expect(row(page, "after:").locator(".suggest-aside")).toHaveText("since:, >:");
  await expect(row(page, "-message:").locator(".suggest-aside")).toHaveCount(0);
  await expect(row(page, "author:").locator(".suggest-description")).toHaveText("Filter by author to see contributions from specific team members");
  await expect(row(page, "ref:").locator(".suggest-description")).toContainText("in the repositories that have it");

  const author = row(page, "author:");
  const label = await box(author.locator(".suggest-label"));
  const aside = await box(author.locator(".suggest-aside"));
  const description = await box(author.locator(".suggest-description"));
  const text = await box(author.locator(".suggest-text"));
  const icon = await box(author.locator(".suggest-icon"));
  expect(Math.abs(aside.top - label.top)).toBeLessThan(4); // the aliases on the operator's line…
  expect(Math.abs(aside.right - text.right)).toBeLessThan(1); // …at its right
  expect(description.top).toBeGreaterThanOrEqual(label.bottom - 1); // what it does, below
  expect(icon.right).toBeLessThanOrEqual(label.left); // the icon at the left
  const style = await author.locator(".suggest-label").evaluate((el) => {
    const s = getComputedStyle(el);
    const probe = document.createElement("span");
    probe.style.fontFamily = "var(--vscode-editor-font-family)";
    document.body.append(probe);
    const editor = getComputedStyle(probe).fontFamily;
    probe.remove();
    return { weight: Number(s.fontWeight), family: s.fontFamily, editor };
  });
  expect(style.weight).toBeGreaterThanOrEqual(600);
  expect(style.family).toBe(style.editor);
  // One accessible name per option, not the parts run together.
  await expect(author).toHaveAttribute("aria-label", "author:, Filter by author to see contributions from specific team members, @:");
  await expect(popup(page).getByRole("listbox")).toHaveAttribute("aria-describedby", "search-suggestions-hint");
  expect(errors).toEqual([]);
});

test("the placeholder says how to use the box, in English and in Chinese", async ({ page }) => {
  await open(page);
  await expect(page.locator("#search")).toHaveAttribute("placeholder", "Search commits (↑↓ for history)");
  await open(page, { path: "/index.zh-cn.html" });
  await expect(page.locator("#search")).toHaveAttribute("placeholder", "搜索提交（↑↓ 查看历史）");
  await page.click("#search");
  await expect(hint(page)).toContainText("组合多个筛选条件");
  await expect(row(page, "message:").locator(".suggest-description")).toHaveText("搜索提交信息，快速找到特定的更改或功能");
  await expect(rows(page).first().locator(".suggest-label")).toHaveText("使用自然语言搜索");
});

test("↓ and ↑ move the highlighted row, Enter and Tab pick, Esc closes; the box keeps focus", async ({ page }) => {
  await open(page);
  await page.click("#search");
  const input = page.locator("#search");
  await expect(rows(page).locator('[aria-selected="true"]')).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute("aria-activedescendant", await rows(page).nth(0).getAttribute("id"));
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(popup(page).locator('[aria-selected="true"]')).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("message:");
  // In an operator's value: its examples, in place of the line on combining.
  await expect(hint(page)).toContainText("Use quotes to search for phrases");
  await expect(rows(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(popup(page)).toBeHidden();
  await expect(input).toHaveValue("message:");
  await page.fill("#search", "fi");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("file:");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("search");
  // Nothing highlighted, the list open: ↑ is the box's, back to the last search.
  await page.fill("#search", "fix");
  await page.keyboard.press("Enter");
  await page.fill("#search", "");
  await expect(popup(page)).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(input).toHaveValue("fix");
  await expect(popup(page)).toBeHidden();
});

test("the mouse hovers without moving the keyboard's row; a click picks and the box keeps focus", async ({ page }) => {
  await open(page);
  await page.click("#search");
  await page.keyboard.press("ArrowDown");
  const author = row(page, "author:");
  const before = await author.evaluate((el) => getComputedStyle(el).backgroundColor);
  await author.hover();
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(author).toHaveAttribute("aria-selected", "false");
  expect(await author.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(before);
  await author.click();
  await expect(page.locator("#search")).toHaveValue("author:");
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("search");
  // Its values follow at once, under its examples.
  await expect(hint(page)).toContainText("Use a name or email");
  await expect(rows(page).first().locator(".suggest-label")).toHaveText("@me");
});

test("values use the same rows: authors over their email, branches and tags over their repository count", async ({ page }) => {
  await open(page);
  await page.click("#search");
  await page.keyboard.type("author:");
  await expect(row(page, "dana").locator(".suggest-description")).toHaveText("dana@example.com");
  await expect(row(page, "dana").locator(".suggest-icon svg")).toHaveCount(1);
  await expect(row(page, "@me").locator(".suggest-description")).toHaveText("You: each repository's user.email");
  await page.fill("#search", "ref:");
  await expect(row(page, "main").locator(".suggest-description")).toHaveText("3 repositories");
  await expect(row(page, "v1.3.2").locator(".suggest-description")).toHaveText("1 repository");
  await expect(row(page, "v1.3.2").locator(".suggest-aside")).toHaveText("tag");
  await expect(hint(page)).toContainText("ref:main..feature");
  await page.fill("#search", "type:");
  await expect(rows(page).locator(".suggest-label")).toHaveText(["tip", "merge", "wip"]);
  await expect(rows(page).locator(".suggest-icon svg")).toHaveCount(3);
});

test("an operator without values shows its examples alone; an error under the box closes the popup", async ({ page }) => {
  await open(page);
  await page.click("#search");
  await page.keyboard.type("file:");
  await expect(popup(page)).toBeVisible();
  await expect(popup(page).locator(".suggest-options")).toBeHidden();
  await expect(hint(page)).toHaveText("Use a path or file name, e.g. file:package.json, or a glob, e.g. ?:src/**/*.ts");
  await page.fill("#search", "commit:xyz");
  await expect(page.locator("#search-errors")).toBeVisible();
  await expect(popup(page)).toBeHidden();
  // Fixed, the popup comes back with the next key.
  await page.fill("#search", "commit:");
  await expect(page.locator("#search-errors")).toBeHidden();
  await expect(hint(page)).toContainText("Use a full or short commit SHA");
});

test("the ✨ row turns natural-language search on; without Linyra AI it is not listed", async ({ page }) => {
  await open(page);
  await page.click("#search");
  await rows(page).first().click();
  await expect(page.locator("#search-ai")).toHaveAttribute("aria-pressed", "true");
  await expect(popup(page)).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("search");
  await open(page, { query: "&ai=off" });
  await page.click("#search");
  await expect(rows(page)).toHaveCount(12);
  await expect(rows(page).first().locator(".suggest-label")).toHaveText("message:");
});

test("the popup fits the panel: capped, its rows scroll under the help line, and it opens above when there is no room below", async ({ page }) => {
  await open(page, { height: 520 });
  await page.click("#search");
  const p = await box(popup(page));
  const field = await box(page.locator("#search-field"));
  expect(p.top).toBeGreaterThanOrEqual(field.bottom);
  expect(p.bottom - p.top).toBeLessThanOrEqual(361);
  const options = popup(page).locator(".suggest-options");
  expect(await options.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  for (let i = 0; i < 13; i++) await page.keyboard.press("ArrowDown");
  const last = await box(rows(page).last());
  const scroller = await box(options);
  expect(last.bottom).toBeLessThanOrEqual(scroller.bottom + 1);
  expect(await options.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // The help line does not scroll away.
  expect((await box(hint(page))).top).toBeCloseTo(p.top + 1, 0);

  // A box near the bottom of a short panel: the popup goes above it.
  await page.evaluate(() => {
    document.getElementById("search").blur();
    document.getElementById("search-field").style.transform = "translateY(400px)";
  });
  await expect(popup(page)).toBeHidden();
  await page.focus("#search");
  const moved = await box(page.locator("#search-field"));
  const up = await box(popup(page));
  await expect(popup(page)).toHaveClass(/above/);
  expect(up.bottom).toBeLessThanOrEqual(moved.top);
  expect(up.top).toBeGreaterThanOrEqual(0);
});

test("rows are built once: typing filters and re-highlights them instead of rebuilding", async ({ page }) => {
  await open(page);
  await page.click("#search");
  await rows(page).evaluateAll((els) => els.forEach((el) => { el.linyraMark = true; }));
  const marked = () => rows(page).evaluateAll((els) => els.map((el) => el.linyraMark === true));
  await page.keyboard.type("a");
  await expect(rows(page).locator(".suggest-label")).toHaveText(["author:", "after:"]);
  expect(await marked()).toEqual([true, true]);
  await expect(row(page, "author:").locator(".suggest-hit")).toHaveText("a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("@");
  // An alias typed: lit among the aliases.
  await expect(row(page, "author:").locator(".suggest-aside .suggest-hit")).toHaveText("@");
  await page.keyboard.press("Backspace");
  await expect(rows(page)).toHaveCount(13);
  expect(await marked()).toEqual(Array(13).fill(true));
  await page.keyboard.type("author:");
  await rows(page).evaluateAll((els) => els.forEach((el) => { el.linyraMark = true; }));
  await page.keyboard.type("d");
  await expect(rows(page).locator(".suggest-label")).toHaveText(["dana"]);
  expect(await marked()).toEqual([true]);
});

for (const theme of ["hc-dark", "hc-light"]) {
  test(`high contrast (${theme}): the highlighted row is outlined, a hovered one dashed`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 520 });
    await page.goto(`/?theme=${theme}&state=default&date=all`);
    await expect(page.locator("#rows .row").first()).toBeVisible();
    await page.click("#search");
    await page.keyboard.press("ArrowDown");
    const active = await rows(page).nth(0).evaluate((el) => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: s.outlineWidth, bg: s.backgroundColor }; });
    expect(active).toMatchObject({ style: "solid", width: "1px", bg: "rgba(0, 0, 0, 0)" });
    await row(page, "author:").hover();
    expect(await row(page, "author:").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("dashed");
  });
}
