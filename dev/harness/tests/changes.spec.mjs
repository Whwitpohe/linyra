// The Log's Changes column (changesColumn.ts), against the harness's stats (dev/harness/mock/changes.ts):
// each commit's files and lines come from its id, ?stats=off answers nothing.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 1900, height = 520, query = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/?theme=${theme}&state=default&avatars=off${query}`);
  await expect(page.locator("#rows .row").first()).toBeVisible();
  return errors;
};
const cell = (page, i) => page.locator(`#rows .row[data-index="${i}"] .changes-cell`);
const messages = (page, type) => page.evaluate((t) => window.harnessMessages.filter((m) => m.type === t), type);
const choose = async (page, name) => {
  if (name === "No Changes Column") {
    await page.locator(".column-header").click({ button: "right" });
    await page.getByRole("menuitemcheckbox", { name: "Changes" }).click();
    return;
  }
  await page.click(".column-header .column-changes button");
  await page.getByRole("menuitemradio", { name: name.replace(/^Changes as (a )?/, ""), exact: true }).click();
};
/** The column's width, as the column header lays it out (the rows share its template). */
const column = (page) => page.evaluate(() => {
  const cell = document.querySelector(".column-header .column-changes");
  return cell ? `${Math.round(cell.getBoundingClientRect().width)}px` : "";
});

test("the bar is the default; the rows on screen ask once they settle, and their cells fill in", async ({ page }) => {
  const errors = await open(page);
  await expect(page.locator("#list")).toHaveClass(/with-changes/);
  await expect(cell(page, 0).locator(".changes-draw.changes-bar")).toBeVisible();
  await expect(cell(page, 0)).toHaveAttribute("aria-label", /^\d+ files changed, \d+ lines added, \d+ lines deleted$/);
  await expect(cell(page, 0)).not.toHaveClass(/pending/);
  const asked = await messages(page, "wantStats");
  expect(asked.length).toBeGreaterThan(0);
  const rows = await page.locator("#rows .row[data-index]").count();
  // Nothing on screen is asked twice once it has arrived, and nothing off screen is asked at all.
  const first = asked[0].commits;
  expect(first.length).toBeLessThanOrEqual(rows);
  expect(new Set(first.map((c) => `${c.repoId}\0${c.sha}`)).size).toBe(first.length);
  expect(errors).toEqual([]);
});

test("scrolling asks for the rows it brings on screen, not the ones it already has", async ({ page }) => {
  await open(page, { height: 400 });
  await expect(cell(page, 0).locator(".changes-draw")).toBeVisible();
  const before = (await messages(page, "wantStats")).flatMap((m) => m.commits.map((c) => c.sha));
  await page.locator("#list").evaluate((el) => { el.scrollTop = 40 * 24; });
  const far = page.locator("#rows .row[data-index]").last();
  await expect(far.locator(".changes-cell .changes-draw")).toBeVisible();
  const after = (await messages(page, "wantStats")).flatMap((m) => m.commits.map((c) => c.sha)).slice(before.length);
  expect(after.length).toBeGreaterThan(0);
  expect(after.filter((sha) => before.includes(sha))).toEqual([]);
});

test("without an answer the cells stay empty and pending", async ({ page }) => {
  const errors = await open(page, { query: "&stats=off" });
  await page.waitForTimeout(400);
  await expect(cell(page, 0)).toHaveClass(/pending/);
  await expect(cell(page, 0)).toBeEmpty();
  expect(errors).toEqual([]);
});

test("the column header picks the drawing, remembers it, and Columns turns the column off", async ({ page }) => {
  await open(page);
  await expect(cell(page, 0).locator(".changes-bar")).toBeVisible();
  await choose(page, "Changes as Numbers");
  await expect(cell(page, 0).locator(".changes-numbers .count-added")).toHaveText(/^\+\d+$/);
  await expect(cell(page, 0).locator(".changes-numbers .count-deleted")).toHaveText(/^−\d+$/);
  await choose(page, "Changes as Squares");
  await expect(cell(page, 0).locator(".changes-squares")).toBeVisible();
  await choose(page, "Changes as a Bipolar Bar");
  await expect(cell(page, 0).locator(".changes-bipolar")).toBeVisible();
  await page.click(".column-header .column-changes button");
  await expect(page.getByRole("menuitemradio", { name: "Bipolar Bar" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await choose(page, "No Changes Column");
  await expect(page.locator("#list")).not.toHaveClass(/with-changes/);
  await expect(page.locator("#rows .changes-cell")).toHaveCount(0);
  const layouts = (await messages(page, "layout")).map((m) => m.changesColumn).filter(Boolean);
  expect(layouts.slice(-4)).toEqual(["numbers", "squares", "bipolar", "off"]);
  // Off asks for nothing more.
  const asked = (await messages(page, "wantStats")).length;
  await page.locator("#list").evaluate((el) => { el.scrollTop = 30 * 24; });
  await page.waitForTimeout(400);
  expect((await messages(page, "wantStats")).length).toBe(asked);
});

test("the column narrows with the Log: files icon and count, then the drawing alone, then a ring", async ({ page }) => {
  await open(page, { width: 1900 });
  await expect(cell(page, 0).locator(".changes-files-icon")).toBeVisible();
  expect(await column(page)).toBe("118px");
  await page.setViewportSize({ width: 1340, height: 520 });
  await expect.poll(() => column(page)).toBe("52px");
  await expect(cell(page, 0).locator(".changes-files")).toHaveCount(0);
  await expect(cell(page, 0).locator(".changes-draw")).toBeVisible();
  await page.setViewportSize({ width: 1150, height: 520 });
  await expect.poll(() => column(page)).toBe("18px");
  await expect(cell(page, 0).locator("svg.changes-ring circle.changes-ring-track")).toHaveCount(1);
  // Numbers get their own widths: the narrowest shows the files count.
  await choose(page, "Changes as Numbers");
  await expect.poll(() => column(page)).toBe("28px");
  await expect(cell(page, 0).locator(".changes-files")).toHaveText(/^\d+\+?$/);
});

test("every drawing stays inside its cell, in each theme and width", async ({ page }) => {
  for (const theme of ["light", "hc-dark"]) {
    for (const width of [1900, 1550, 1340]) {
      const errors = await open(page, { theme, width });
      for (const name of ["Changes as Numbers", "Changes as Squares", "Changes as a Bar", "Changes as a Bipolar Bar"]) {
        await choose(page, name);
        await expect(cell(page, 0)).not.toHaveClass(/pending/);
        // The cell, and the deleted count that would give way first (an ellipsis).
        const overflow = await page.locator("#rows .row[data-index] :is(.changes-cell, .count-deleted)").evaluateAll((cells) =>
          cells.filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent));
        expect(overflow, `${theme} ${width} ${name}`).toEqual([]);
      }
      expect(errors).toEqual([]);
    }
  }
});
