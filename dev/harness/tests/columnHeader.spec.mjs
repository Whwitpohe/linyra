// The Log's column header (columnHeader.ts, logColumns.ts): its cells over the rows' cells at every
// width, each column's options on hover and in its menu, Columns, resizing by its sashes, the
// keyboard, File History, and its look in every theme.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 1500, height = 640, query = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/?theme=${theme}&state=default&avatars=off${query}`);
  await expect(page.locator("#rows .row").first()).toBeVisible();
  await expect(page.locator(".column-header .column-head").first()).toBeVisible();
  return errors;
};
const header = (page) => page.locator(".column-header");
const head = (page, id) => page.locator(`.column-header .column-${id}`);
const sent = (page, type) => page.evaluate((t) => window.harnessMessages.filter((m) => m.type === t), type);
/** Each header cell's and the first row's cells' [left, right], by column. */
const edges = (page, rowSelector = "#rows .row[data-index]") => page.evaluate((sel) => {
  const box = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; };
  const heads = [...document.querySelectorAll(".column-header .column-head")].map((el) => [el.dataset.column, box(el)]);
  const row = document.querySelector(sel);
  return { heads, cells: row ? [...row.children].filter((c) => getComputedStyle(c).display !== "none").map(box) : [] };
}, rowSelector);
const width = (locator) => locator.evaluate((el) => Math.round(el.getBoundingClientRect().width));

for (const w of [1700, 1100, 700]) {
  test(`at ${w}px every header cell sits exactly over its column of cells`, async ({ page }) => {
    const errors = await open(page, { width: w });
    const { heads, cells } = await edges(page);
    expect(heads.length).toBe(cells.length);
    heads.forEach(([id, [l, r]], i) => {
      expect(Math.abs(l - cells[i][0]), `${id} left`).toBeLessThanOrEqual(1);
      expect(Math.abs(r - cells[i][1]), `${id} right`).toBeLessThanOrEqual(1);
    });
    expect(errors).toEqual([]);
  });
}

test("columns: Repository, Graph, Message, Author, Changes, Date; narrow: the repository a strip, no author", async ({ page }) => {
  await open(page, { width: 1500 });
  await expect(header(page).locator(".column-head")).toHaveCount(6);
  expect(await header(page).locator(".column-head").evaluateAll((els) => els.map((e) => e.dataset.column))).toEqual(["repo", "graph", "message", "author", "changes", "date"]);
  await expect(header(page)).toHaveAttribute("role", "row");
  await expect(header(page).locator('[role="columnheader"]')).toHaveCount(6);
  // The header is the grid's first row, the summary row of uncommitted work the second; the commits
  // are numbered after them, and counted with them.
  await expect(header(page)).toHaveAttribute("aria-rowindex", "1");
  await expect(page.locator(".work-summary")).toHaveAttribute("aria-rowindex", "2");
  await expect(page.locator('#rows .row[data-index="0"]')).toHaveAttribute("aria-rowindex", "3");
  const shown = await page.evaluate(() => document.querySelectorAll("#rows .row[data-index]").length);
  expect(shown).toBeGreaterThan(0);
  expect(Number(await page.locator("#list").getAttribute("aria-rowcount"))).toBeGreaterThan(shown + 1);
  await page.setViewportSize({ width: 700, height: 640 });
  await expect.poll(() => header(page).locator(".column-head").evaluateAll((els) => els.map((e) => e.dataset.column))).toEqual(["repo", "graph", "message", "changes", "date"]);
  expect(await width(head(page, "repo"))).toBeLessThanOrEqual(4);
  await expect(header(page).locator(".column-sash")).toHaveCount(0);
  await expect(page.locator("#rows .row .author")).toHaveCount(0);
});

test("a column's options show on hover and on focus; a filter that is on stays shown", async ({ page }) => {
  await open(page);
  const search = head(page, "message").locator('[data-key="search"]');
  const opacity = (l) => l.evaluate((el) => Number(getComputedStyle(el).opacity));
  await page.mouse.move(5, 5);
  await expect.poll(() => opacity(search)).toBe(0);
  await head(page, "message").hover();
  await expect.poll(() => opacity(search)).toBe(1);
  await page.mouse.move(5, 5);
  await search.focus();
  await expect.poll(() => opacity(search)).toBe(1);
  // The harness opens on the last 24 hours: the Date header says a range is on, without hovering.
  await expect(head(page, "date").locator(".column-state")).toBeVisible();
  await expect(head(page, "date").locator("button")).toHaveAttribute("aria-label", /date range is on/);
  // Message's search focuses the Search box; Author's filter opens its picker.
  await search.click();
  await expect(page.locator("#search")).toBeFocused();
  await head(page, "author").hover();
  await head(page, "author").locator('[data-key="author"]').click();
  await expect(page.locator("#author")).toHaveAttribute("aria-expanded", "true");
});

test("the Graph menu orders the Log and folds linear history; its button says the order", async ({ page }) => {
  await open(page);
  const graph = head(page, "graph").locator("button");
  await expect(graph).toHaveAttribute("aria-label", "Graph: By commit date");
  await graph.click();
  const menu = page.getByRole("menu", { name: "Graph" });
  await expect(menu.getByRole("menuitemradio", { name: "By commit date" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: "By commit date" })).toBeFocused();
  await menu.getByRole("menuitemradio", { name: "By branch structure" }).click();
  await expect.poll(async () => (await sent(page, "filter")).at(-1)?.filter.sort).toBe("topo");
  await expect(graph).toHaveAttribute("aria-label", "Graph: By branch structure");
  await expect(graph).toHaveClass(/active/);
  await expect(page.locator("#order-note")).toHaveText("Incoming commits below their merge");
  await expect(graph).toBeFocused();
});

test("the Changes and Date menus change their columns, and the choice is saved", async ({ page }) => {
  await open(page);
  await head(page, "changes").locator("button").click();
  await page.getByRole("menuitemradio", { name: "Numbers" }).click();
  await expect(page.locator("#rows .row").first().locator(".changes-numbers")).toBeVisible();
  const before = await width(head(page, "date"));
  await head(page, "date").locator("button").click();
  await page.getByRole("menuitemradio", { name: /^Absolute/ }).click();
  await expect(page.locator("#rows .row[data-index] .date").first()).toHaveText(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
  expect(await width(head(page, "date"))).toBeGreaterThan(before);
  const layouts = await sent(page, "layout");
  expect(layouts.some((m) => m.changesColumn === "numbers")).toBe(true);
  expect(layouts.at(-1).columns).toMatchObject({ dates: "absolute" });
  // Its menu also holds Filter by Date…, which opens the date range.
  await head(page, "date").locator("button").click();
  await page.getByRole("menuitem", { name: "Filter by Date…" }).click();
  await expect(page.locator("#date")).toBeFocused();
});

test("an init that changes nothing (the host sets a filter it already had) keeps the rows it drew", async ({ page }) => {
  await page.addInitScript(() => { window.inits = []; addEventListener("message", (e) => { if (e.data?.type === "init") window.inits.push(e.data); }); });
  await open(page);
  const row = await page.locator('#rows .row[data-index="0"]').elementHandle();
  await page.evaluate(() => window.postMessage(window.inits.at(-1), "*"));
  await page.waitForTimeout(300);
  expect(await row.evaluate((el) => el.isConnected)).toBe(true);
});

test("narrow: Columns offers only what the narrow Log can show; an open menu keeps its button shown", async ({ page }) => {
  await open(page, { width: 700 });
  await header(page).click({ button: "right" });
  const columns = page.getByRole("menu", { name: "Columns" });
  for (const name of ["Repository Name", "Hash", "Author"]) await expect(columns.getByRole("menuitemcheckbox", { name })).toBeDisabled();
  for (const name of ["Changes", "Date"]) await expect(columns.getByRole("menuitemcheckbox", { name })).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1500, height: 640 });
  // The Changes menu open, the pointer in it: the Changes button and its chevron stay shown.
  await head(page, "changes").locator("button").click();
  await page.getByRole("menuitemradio", { name: "Numbers" }).hover();
  const opacity = (sel) => head(page, "changes").locator(sel).first().evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(await opacity(".column-button")).toBe(1);
  await expect.poll(() => opacity(".column-chevron")).toBe(1);
  // So does the gear, a column tool.
  await page.keyboard.press("Escape");
  await head(page, "message").locator(".column-settings").click();
  await page.getByRole("menuitemcheckbox", { name: "Hash" }).hover();
  await expect.poll(() => head(page, "message").locator(".column-settings").evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1);
});

test("Columns: right-click, the gear or Shift+F10; hide and show a column; Graph and Message always show", async ({ page }) => {
  await open(page);
  await header(page).click({ button: "right" });
  const columns = page.getByRole("menu", { name: "Columns" });
  await expect(columns.getByRole("menuitemcheckbox")).toHaveText(["Repository Name", "Hash", "Author", "Changes", "Date"]);
  await expect(columns.getByRole("menuitem", { name: "Reset Column Widths" })).toBeDisabled();
  await columns.getByRole("menuitemcheckbox", { name: "Author" }).click();
  await expect(head(page, "author")).toHaveCount(0);
  await expect(page.locator("#rows .row .author")).toHaveCount(0);
  expect((await sent(page, "layout")).at(-1).columns.hidden).toEqual(["author"]);
  // The gear, on Message's header.
  await head(page, "message").hover();
  await head(page, "message").locator('[data-key="columns"]').click();
  await page.getByRole("menuitemcheckbox", { name: "Repository Name" }).click();
  expect(await width(head(page, "repo"))).toBeLessThanOrEqual(4);
  await expect(page.locator("#rows .row .repo-label")).toHaveCount(0);
  // From the keyboard.
  await head(page, "graph").locator("button").focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menu", { name: "Columns" }).getByRole("menuitemcheckbox", { name: "Hash" }).click();
  await expect(page.locator("#rows .row .hash").first()).toHaveText(/^[0-9a-f]{8}$/);
  const { heads, cells } = await edges(page);
  expect(heads.map(([id]) => id)).toEqual(["repo", "graph", "message", "hash", "changes", "date"]);
  expect(cells.length).toBe(heads.length);
});

test("letting go of a sash past its column's range saves the width it is drawn at", async ({ page }) => {
  await open(page);
  const author = head(page, "author");
  const sash = author.locator(".column-sash");
  await author.hover();
  const box = await sash.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 900, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await sent(page, "layout")).at(-1)?.columns?.widths?.author).toBeTruthy();
  const saved = (await sent(page, "layout")).at(-1).columns.widths.author;
  expect(Math.abs(saved - (await width(author)))).toBeLessThanOrEqual(1);
});

test("the Changes header turns to its icon, and back to its name, as the window narrows and widens", async ({ page }) => {
  await open(page);
  for (const w of [1700, 1000, 780, 1700]) {
    await page.setViewportSize({ width: w, height: 640 });
    await expect.poll(async () => {
      const px = await width(head(page, "changes"));
      // Its name, or (narrower) only its icon.
      const named = await head(page, "changes").locator(".column-label").count();
      return (px < 72) === (named === 0);
    }, { message: `at ${w}px` }).toBe(true);
  }
});

test("a sash resizes its column, header and rows together; letting go saves it; a double-click resets it", async ({ page }) => {
  await open(page);
  const author = head(page, "author");
  const before = await width(author);
  const sash = author.locator(".column-sash");
  await author.hover();
  const box = await sash.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => width(author)).toBeGreaterThanOrEqual(before + 55);
  expect(Math.abs((await width(page.locator("#rows .row[data-index] .author").first())) - (await width(author)))).toBeLessThanOrEqual(1);
  const saved = (await sent(page, "layout")).at(-1).columns.widths.author;
  expect(saved).toBeGreaterThanOrEqual(before + 55);
  await header(page).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Reset Column Widths" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await author.hover();
  await sash.dblclick();
  await expect.poll(() => width(author)).toBe(before);
  expect((await sent(page, "layout")).at(-1).columns.widths).toEqual({});
});

test("one Tab stop: ← → move between the header's buttons; the rows still scroll under it", async ({ page }) => {
  await open(page, { height: 420 });
  const buttons = header(page).locator("button[data-key]");
  await expect(header(page).locator('button[tabindex="0"]')).toHaveCount(1);
  await buttons.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(buttons.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(buttons.first()).toBeFocused();
  // Sticky: scrolled, the header stays at the top and the selected row is never hidden under it.
  const top = (await header(page).boundingBox()).y;
  await page.locator("#list").focus();
  await page.keyboard.press("End");
  await expect.poll(async () => (await header(page).boundingBox()).y).toBe(top);
  // Home: the summary row of uncommitted work, first under the header; ↓: the newest commit, under it.
  await page.keyboard.press("Home");
  const work = page.locator('.work-summary[aria-selected="true"]');
  await expect(work).toBeVisible();
  const h = await header(page).boundingBox(), w = await work.boundingBox();
  expect(w.y).toBeGreaterThanOrEqual(h.y + h.height - 1);
  await page.keyboard.press("ArrowDown");
  const selected = page.locator("#rows .row.focus");
  await expect(selected).toBeVisible();
  const r = await selected.boundingBox();
  expect(r.y).toBeGreaterThanOrEqual(w.y + w.height - 1);
});

test("File History: its own change column, lined up with the uncommitted row and the commits", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 640 });
  await page.goto("/?theme=dark&state=default&history=src%2Fclient.ts&avatars=off");
  await expect(page.locator("#rows .row").first()).toBeVisible();
  const ids = await header(page).locator(".column-head").evaluateAll((els) => els.map((e) => e.dataset.column));
  expect(ids).toEqual(["repo", "graph", "message", "file", "author", "date"]);
  const { heads, cells } = await edges(page);
  heads.forEach(([id, [l]], i) => expect(Math.abs(l - cells[i][0]), id).toBeLessThanOrEqual(1));
  const work = page.locator("#history-work");
  if (await work.isVisible()) {
    const w = await edges(page, "#history-work");
    heads.forEach(([id, [l]], i) => expect(Math.abs(l - w.cells[i][0]), `work ${id}`).toBeLessThanOrEqual(1));
  }
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`the header in ${theme}: opaque over the rows, muted text, VS Code's menu colors, no console errors`, async ({ page }) => {
    const errors = await open(page, { theme });
    const s = await header(page).evaluate((el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, color: c.color, body: getComputedStyle(document.body).backgroundColor }; });
    expect(s.bg).toBe(s.body);
    expect(s.bg).not.toBe("rgba(0, 0, 0, 0)");
    await head(page, "changes").locator("button").click();
    const menu = page.locator(".popup-menu");
    await expect(menu).toBeVisible();
    const checked = menu.locator('[aria-checked="true"]');
    await expect(checked).toBeFocused();
    const m = await menu.evaluate((el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, color: c.color }; });
    expect(m.bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(m.color).not.toBe(m.bg);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
