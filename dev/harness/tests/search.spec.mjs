// The search box: GitLens-style operators with a suggestions list, values for author:/ref:/repo:/type:,
// the last searches on ↑/↓, errors under the box, Enter without the debounce, and the ✨ mode.
import { expect, test } from "@playwright/test";

const open = async (page, { query = "", width = 1600, height = 520, clear = true } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/?theme=dark&state=default&date=all${query}`);
  if (clear) await page.evaluate(() => sessionStorage.clear());
  await expect(page.locator("#rows .row").first()).toBeVisible();
  return errors;
};
const list = (page) => page.locator("#search-suggestions");
const rows = (page) => list(page).locator(".suggest-row");
/** The filters the webview sent, newest last. */
const sent = (page) => page.evaluate(() => window.harnessMessages.filter((m) => m.type === "filter").map((m) => ({ text: m.filter.text, now: m.now === true, wholeWord: m.filter.wholeWord, matchAll: m.filter.matchAll })));

test("an empty box lists every operator with what it does and its aliases", async ({ page }) => {
  const errors = await open(page);
  await page.click("#search");
  await expect(list(page)).toBeVisible();
  // ✨ first (Linyra AI is set up in the harness), then the twelve operators.
  await expect(rows(page)).toHaveCount(13);
  await expect(rows(page).nth(1).locator(".suggest-label")).toHaveText("message:");
  await expect(rows(page).nth(1).locator(".suggest-description")).toContainText("commit messages");
  await expect(rows(page).filter({ hasText: "author:" }).first().locator(".suggest-aside")).toHaveText("@:");
  await expect(page.locator("#search")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(list(page)).toBeHidden();
  expect(errors).toEqual([]);
});

test("typing an operator narrows the list; picking it lists its values, and a value runs the search", async ({ page }) => {
  await open(page);
  await page.click("#search");
  await page.keyboard.type("au");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().locator(".suggest-hit")).toHaveText("au");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#search")).toHaveValue("author:");
  // The value list: @me first, then the people who committed recently.
  await expect(rows(page).first().locator(".suggest-label")).toHaveText("@me");
  await page.keyboard.type("ri");
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#search")).toHaveValue("author:rin@example.com ");
  await expect(page.locator("#rows .row").first()).toBeVisible();
  await expect.poll(async () => (await page.locator("#rows .row .author").allTextContents()).every((a) => a.includes("rin"))).toBe(true);
  expect((await sent(page)).at(-1).text).toBe("author:rin@example.com ");
});

test("value suggestions for repo:, type: and ref: (branches and tags)", async ({ page }) => {
  await open(page);
  await page.click("#search");
  await page.keyboard.type("repo:");
  await expect(rows(page).locator(".suggest-label")).toHaveText(["acme-web", "acme-api", "acme-libs"]);
  await page.keyboard.type("li");
  await expect(rows(page)).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(page.locator("#search")).toHaveValue("repo:acme-libs ");
  await page.keyboard.type("type:");
  await expect(rows(page).locator(".suggest-label")).toHaveText(["tip", "merge", "wip"]);
  await page.keyboard.press("Escape");
  await page.fill("#search", "ref:v1");
  await page.keyboard.press("End");
  await expect(rows(page).filter({ hasText: "v1.4.0" })).toHaveCount(1);
  await expect(rows(page).filter({ hasText: "v1.4.0" }).locator(".suggest-aside")).toHaveText("tag");
  await expect(rows(page).filter({ hasText: "v1.4.0" }).locator(".suggest-description")).toHaveText("2 repositories");
});

test("an operator without its value is not searched; Enter says what it waits for", async ({ page }) => {
  await open(page);
  await page.click("#search");
  await page.keyboard.type("fix ");
  await expect.poll(async () => (await sent(page)).at(-1)?.text).toBe("fix");
  const before = (await sent(page)).length;
  await page.fill("#search", "fix author:");
  await page.waitForTimeout(400);
  expect((await sent(page)).length).toBe(before);
  await expect(page.locator("#search-errors")).toBeHidden();
  await page.keyboard.press("Escape"); // the list
  await page.keyboard.press("Enter");
  await expect(page.locator("#search-errors")).toBeVisible();
  await expect(page.locator("#search-errors")).toHaveText("author: needs a value");
  await expect(page.locator("#search")).toHaveAttribute("aria-invalid", "true");
  expect((await sent(page)).length).toBe(before);
  await page.keyboard.type("dana");
  await expect(page.locator("#search-errors")).toBeHidden();
  await expect(page.locator("#search")).not.toHaveAttribute("aria-invalid", "true");
  await expect.poll(async () => (await sent(page)).at(-1)?.text).toBe("fix author:dana");
});

test("errors appear under the box, marked aria-invalid, and the box keeps what is typed", async ({ page }) => {
  await open(page);
  await page.fill("#search", "fix commit:xyz");
  await page.keyboard.press("Enter");
  const message = page.locator("#search-errors");
  await expect(message).toBeVisible();
  await expect(message).toContainText("commit: takes a commit hash");
  await expect(page.locator("#search")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#search")).toHaveAttribute("aria-describedby", /search-errors/);
  // Another filter changing does not throw away the query being fixed.
  await page.click("#match-case");
  await expect(page.locator("#search")).toHaveValue("fix commit:xyz");
  await page.fill("#search", "message:fix -message:wip");
  await expect(message).toContainText("cannot be used together", { timeout: 2000 });
  await page.fill("#search", "fix(", { timeout: 1000 });
  await page.click("#use-regex");
  await page.click("#search");
  await expect(message).toContainText("Invalid regular expression");
  await page.click("#use-regex");
  await page.click("#search");
  await expect(message).toBeHidden();
  expect((await sent(page)).at(-1).text).toBe("fix(");
});

test("Enter runs at once, without the typing debounce; Whole Word and Match All are sent", async ({ page }) => {
  await open(page);
  await page.click("#search");
  await page.keyboard.type("retry");
  await page.keyboard.press("Enter");
  expect((await sent(page)).at(-1)).toEqual({ text: "retry", now: true, wholeWord: undefined, matchAll: undefined });
  await page.click("#whole-word");
  await expect(page.locator("#whole-word")).toHaveAttribute("aria-pressed", "true");
  await page.click("#match-all");
  expect((await sent(page)).at(-1)).toMatchObject({ wholeWord: true, matchAll: true });
});

test("↑ and ↓ walk through the last searches, kept with the view's state", async ({ page }) => {
  await open(page);
  for (const q of ["fix", "author:rin", "file:*.ts"]) {
    await page.fill("#search", q);
    await page.keyboard.press("Enter");
  }
  await page.fill("#search", "draft");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#search")).toHaveValue("file:*.ts");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#search")).toHaveValue("author:rin");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#search")).toHaveValue("file:*.ts");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#search")).toHaveValue("draft");
  // A reload keeps them (the webview's own state).
  await page.reload();
  await expect(page.locator("#rows .row, #empty").first()).toBeVisible();
  await page.fill("#search", "");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#search")).toHaveValue("file:*.ts");
});

test("type:wip shows the Uncommitted side; the rest of the query stays", async ({ page }) => {
  await open(page);
  await page.fill("#search", "fix type:wip");
  await expect(page.locator("#mode-work")).toHaveAttribute("aria-selected", "true");
  await page.click("#mode-commits");
  await expect(page.locator("#search")).toHaveValue("fix");
});

test("✨ sends the words to Linyra AI and runs the query it returns", async ({ page }) => {
  await open(page);
  await expect(page.locator("#search-ai")).toHaveAttribute("aria-disabled", "false");
  await page.click("#search-ai");
  await expect(page.locator("#search-ai")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#search")).toHaveAttribute("placeholder", /Describe the commits/);
  await expect(page.locator(".search-toggles")).toBeHidden();
  await page.keyboard.type("my fixes in acme-web last week");
  await expect(list(page)).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(page.locator("#search")).toHaveValue("@me repo:acme-web after:1.week.ago fix");
  await expect(page.locator("#search-ai")).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.harnessMessages.filter((m) => m.type === "aiSearch").map((m) => m.text))).toEqual(["my fixes in acme-web last week"]);
  expect((await sent(page)).at(-1)).toMatchObject({ text: "@me repo:acme-web after:1.week.ago fix", now: true });
});

test("without Linyra AI, ✨ is unavailable and asks to set it up", async ({ page }) => {
  await open(page, { query: "&ai=off" });
  await expect(page.locator("#search-ai")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#search-ai")).toHaveAttribute("title", /needs Linyra AI/);
  // aria-disabled, not disabled: it stays focusable and clickable, to offer the setup.
  await page.click("#search-ai", { force: true });
  await expect(page.locator("#search-ai")).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.harnessMessages.some((m) => m.type === "aiConfigure"))).toBe(true);
});

test("operators filter the mock log with the product's own parser", async ({ page }) => {
  await open(page);
  const count = async () => Number((await page.locator("#count").textContent()).match(/\d+/)?.[0] ?? 0);
  await expect.poll(count).toBeGreaterThan(100);
  const all = await count();
  await page.fill("#search", "repo:acme-web");
  await page.keyboard.press("Enter");
  await expect.poll(count).toBe(all / 3);
  await expect.poll(async () => new Set(await page.locator("#rows .row .repo-label").allTextContents()).size).toBe(1);
  await page.fill("#search", "fix -message:guard");
  await page.keyboard.press("Enter");
  await expect(page.locator("#search-errors")).toContainText("cannot be used together");
  await page.fill("#search", "-message:fix");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await page.locator("#rows .row .subject").allTextContents()).some((s) => /fix/i.test(s))).toBe(false);
});
