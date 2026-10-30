// The Log's summary row of uncommitted work (webview/workSummary.ts, workRow.ts, list.ts), against
// the harness's mock work (dev/harness/mock/worktree.ts: three repositories by default; ?work=one,
// ?work=off): above the newest commit, in its columns; selecting it shows that work in the Changes
// view without leaving the commits; the arrow keys reach it; it goes when there is nothing or a search.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 1500, height = 640, work = "", locale = "", query = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/${locale ? `index.${locale}.html` : ""}?theme=${theme}&state=default&avatars=off${work ? `&work=${work}` : ""}${query}`);
  await expect(page.locator("#rows .row").first()).toBeVisible();
  return errors;
};
const summary = (page) => page.locator(".work-summary");
const row = (page, i) => page.locator(`#rows .row[data-index="${i}"]`);
const sent = (page, type) => page.evaluate((t) => window.harnessMessages.filter((m) => m.type === t), type);
const hostSays = (page, m) => page.evaluate((message) => window.postMessage(message, "*"), m);
const nothing = { type: "uncommitted", known: true, totals: { files: 0, repos: 0, added: 0, deleted: 0 }, rows: [] };

test("above the newest commit, in its columns: three repositories, their chips, the files by kind, the lines and the latest edit", async ({ page }) => {
  const errors = await open(page);
  const s = summary(page);
  await expect(s).toBeVisible();
  await expect(s).toHaveAttribute("role", "row");
  await expect(s).toHaveAttribute("aria-rowindex", "2");
  await expect(s.locator(".summary-subject")).toHaveText("Uncommitted changes");
  await expect(s.locator(".repo-band")).toHaveText("3 repositories");
  await expect(s.locator(".repo-band")).toHaveClass(/summary-band/);
  await expect(s.locator(".summary-chip")).toHaveCount(3);
  await expect(s.locator(".summary-kinds .count").first()).toBeVisible();
  // The Changes column draws its lines as it draws a commit's; the date column its edit, as a commit's date.
  await expect(s.locator(".changes-cell")).toHaveCount(1);
  await expect(s.locator(".summary-lines")).toHaveCount(0);
  await expect(s.locator(".date")).toHaveText(/ago|just now/);
  await expect(s).toHaveAttribute("aria-label", /^Uncommitted changes, 3 repositories, \d+ files, \d+ lines added, \d+ deleted, edited/);
  // Its cells sit in the commits' columns: the same template, each cell over the commit's.
  const cells = async (el) => el.evaluate((r) => [...r.children].filter((c) => getComputedStyle(c).position !== "absolute").map((c) => Math.round(c.getBoundingClientRect().left)));
  expect(await cells(s)).toEqual(await cells(row(page, 0)));
  // Directly above the newest commit, under the column header.
  const [hb, sb, rb] = [await page.locator(".column-header").boundingBox(), await s.boundingBox(), await row(page, 0).boundingBox()];
  expect(Math.abs(sb.y - (hb.y + hb.height))).toBeLessThan(1.5);
  expect(Math.abs(rb.y - (sb.y + sb.height))).toBeLessThan(1.5);
  expect(sb.height).toBeCloseTo(rb.height, 0);
  // A dashed node where the commits' first lane is.
  await expect(s.locator(".summary-node")).toHaveCSS("stroke-dasharray", /\d/);
  expect(errors).toEqual([]);
});

test("one repository: its name in the repository column, its color, its own menu; no chips", async ({ page }) => {
  await open(page, { work: "one" });
  const s = summary(page);
  await expect(s.locator(".summary-chip")).toHaveCount(0);
  await expect(s.locator(".repo-band")).toHaveClass(/accent-\d/);
  await expect(s.locator(".repo-band")).not.toHaveClass(/summary-band/);
  const context = JSON.parse(await s.getAttribute("data-vscode-context"));
  expect(context).toMatchObject({ webviewSection: "uncommitted", canStage: true, preventDefaultContextMenuItems: true });
  expect(await s.locator(".repo-band").textContent()).toBe(context.repoId.split("/").pop());
});

test("nothing uncommitted: no row, and the commits start under the header", async ({ page }) => {
  await open(page, { work: "off" });
  await expect(summary(page)).toBeHidden();
  await expect(row(page, 0)).toHaveAttribute("aria-rowindex", "2");
  const [hb, rb] = [await page.locator(".column-header").boundingBox(), await row(page, 0).boundingBox()];
  expect(Math.abs(rb.y - (hb.y + hb.height))).toBeLessThan(1.5);
});

test("a click selects it: its work in the Changes view, no commit selected, the Commits side kept", async ({ page }) => {
  await open(page);
  await row(page, 3).locator(".subject").click();
  await summary(page).locator(".summary-subject").click();
  await expect(summary(page)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('#rows .row[aria-selected="true"]')).toHaveCount(0);
  await expect(page.locator("#list")).toHaveAttribute("aria-activedescendant", "row-work");
  expect((await sent(page, "showWork")).at(-1)).toEqual({ type: "showWork" });
  await expect(page.locator("#summary")).toContainText("Uncommitted changes");
  await expect(page.locator("#mode-commits")).toHaveAttribute("aria-selected", "true");
  // The first chip is whose files show; a chip's click shows another's.
  await expect(summary(page).locator(".summary-chip").first()).toHaveAttribute("aria-current", "true");
  const second = summary(page).locator(".summary-chip").nth(1);
  const repoId = await second.getAttribute("data-work-repo");
  await second.click();
  expect((await sent(page, "showWork")).at(-1)).toEqual({ type: "showWork", repoId });
  await expect(second).toHaveAttribute("aria-current", "true");
  await expect(summary(page).locator(".summary-chip").first()).not.toHaveAttribute("aria-current", "true");
  // Each chip's right-click is its repository's menu, as on the Uncommitted side.
  expect(JSON.parse(await second.getAttribute("data-vscode-context"))).toMatchObject({ webviewSection: "uncommitted", repoId });
  // A commit's click takes the selection back, and the host reads that commit.
  const before = (await sent(page, "select")).length;
  await row(page, 2).locator(".subject").click();
  await expect(summary(page)).toHaveAttribute("aria-selected", "false");
  await expect(row(page, 2)).toHaveAttribute("aria-selected", "true");
  expect((await sent(page, "select")).length).toBe(before + 1);
});

test("the arrow keys: ↑ from the newest commit reaches it, ↓ goes back, Home goes to it", async ({ page }) => {
  await open(page);
  await row(page, 0).locator(".subject").click();
  const firstKey = await page.locator("#list").getAttribute("aria-activedescendant");
  await page.keyboard.press("ArrowUp");
  await expect(summary(page)).toHaveAttribute("aria-selected", "true");
  expect((await sent(page, "showWork")).length).toBe(1);
  await page.keyboard.press("ArrowUp");
  expect((await sent(page, "showWork")).length).toBe(1, "already there: not chosen again");
  await page.keyboard.press("ArrowDown");
  await expect(summary(page)).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#list")).toHaveAttribute("aria-activedescendant", firstKey);
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  await expect(summary(page)).toHaveAttribute("aria-selected", "true");
  await expect(summary(page)).toBeInViewport();
});

test("Commit…: on hover at the row's end; several repositories open the Commit side bar as it is, one opens it for that one", async ({ page }) => {
  await open(page);
  await summary(page).hover();
  const commit = summary(page).locator(".summary-commit");
  await expect(commit).toBeVisible();
  await expect(commit).toHaveAttribute("aria-label", "Commit…");
  await commit.click();
  expect(await sent(page, "commitWork")).toEqual([{ type: "commitWork" }]);
  await expect(summary(page)).toHaveAttribute("aria-selected", "false", { timeout: 1000 });
  await open(page, { work: "one" });
  await summary(page).hover();
  await summary(page).locator(".summary-commit").click();
  const [one] = await sent(page, "commitWork");
  expect(one.repoId).toMatch(/^\/work\/acme-/);
});

test("it goes with a search, and comes back when the search is cleared", async ({ page }) => {
  await open(page);
  await page.locator("#search").fill("retry");
  await page.keyboard.press("Enter");
  await expect(summary(page)).toBeHidden();
  await page.locator("#search").fill("");
  await page.keyboard.press("Enter");
  await expect(summary(page)).toBeVisible();
});

test("selected when everything is committed: the row goes and the newest commit takes the selection", async ({ page }) => {
  await open(page);
  await summary(page).locator(".summary-subject").click();
  const before = (await sent(page, "select")).length;
  await hostSays(page, nothing);
  await expect(summary(page)).toBeHidden();
  await expect(page.locator('#rows .row[aria-selected="true"]')).toHaveCount(1);
  // Posted after the row is drawn selected: polled, as a loaded machine posts it a frame later.
  await expect.poll(async () => (await sent(page, "select")).length).toBe(before + 1);
});

test("it scrolls away with the commits; the last commit is still reachable; it coming or going keeps the commits in place", async ({ page }) => {
  // The whole history: room to scroll past the row and to stay clear of the end.
  await open(page, { height: 420, query: "&date=all" });
  const list = page.locator("#list");
  await list.evaluate((el) => { el.scrollTop = 200; });
  await expect(summary(page)).not.toBeInViewport({ ratio: 0.5 });
  // The end: the last commit is whole, its bottom at the list's (the scroll counts the row above the commits).
  await list.focus();
  await page.keyboard.press("End");
  const last = page.locator("#rows .row.focus");
  await expect(last).toBeVisible();
  const [lb, vb] = [await last.boundingBox(), await list.boundingBox()];
  expect(Math.abs(lb.y + lb.height - (vb.y + vb.height))).toBeLessThan(1.5);
  // Scrolled down, the row going leaves what is on screen where it was (measured once the list has painted).
  await list.evaluate((el) => { el.scrollTop = 300; });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const onScreen = async () => page.evaluate(() => {
    const top = document.querySelector(".column-header").getBoundingClientRect().bottom;
    const r = [...document.querySelectorAll("#rows .row[data-index]")].find((el) => el.getBoundingClientRect().top >= top);
    return { index: r.dataset.index, y: Math.round(r.getBoundingClientRect().top) };
  });
  const before = await onScreen();
  await hostSays(page, nothing);
  await expect(summary(page)).toBeHidden();
  await expect.poll(onScreen).toEqual(before);
});

test("back from the Uncommitted side with the row selected: its work again", async ({ page }) => {
  await open(page);
  await summary(page).locator(".summary-subject").click();
  await page.locator("#mode-work").click();
  await expect(summary(page)).toBeHidden();
  await page.locator("#mode-commits").click();
  await expect(summary(page)).toHaveAttribute("aria-selected", "true");
  const modes = await page.evaluate(() => window.harnessMessages.filter((m) => m.type === "logMode" || m.type === "showWork").map((m) => m.mode ?? m.type));
  expect(modes.slice(-3)).toEqual(["uncommitted", "commits", "showWork"]);
});

for (const theme of ["light", "hc-dark", "hc-light"]) {
  test(`${theme}: hovered and selected read without tints where the theme has none`, async ({ page }) => {
    const errors = await open(page, { theme });
    const s = summary(page);
    await s.hover();
    const hover = await s.evaluate((el) => ({ outline: getComputedStyle(el).outlineStyle, bg: getComputedStyle(el).backgroundColor }));
    await s.locator(".summary-subject").click();
    const selected = await s.evaluate((el) => getComputedStyle(el).outlineStyle);
    if (theme.startsWith("hc")) {
      expect(hover.outline).toBe("dashed");
      expect(selected).toBe("solid");
      await expect(s.locator(".summary-chip").first()).toHaveCSS("outline-style", "solid");
    } else expect(hover.bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(errors).toEqual([]);
  });
}

test("zh-cn: the row speaks Chinese", async ({ page }) => {
  await open(page, { locale: "zh-cn" });
  await expect(summary(page).locator(".summary-subject")).toHaveText("未提交的更改");
  await expect(summary(page).locator(".repo-band")).toHaveText("3 个仓库");
  await expect(summary(page).locator(".date")).toHaveText(/前|刚刚/);
  await summary(page).hover();
  await expect(summary(page).locator(".summary-commit")).toHaveAttribute("title", "提交…");
  await expect(summary(page).locator(".summary-chip").first()).toHaveAttribute("title", /^显示 acme-\S+ 中未提交的更改$/);
});
