// File History against the dev harness (plan 3.D): the chip in place of the switch, each row's
// change to the file, the uncommitted row above the commits, the never-committed empty state,
// and the Repo List at full strength with the file's repository marked.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 1500, height = 480, file = "src/client.ts", extra = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/?theme=${theme}&state=default&history=${encodeURIComponent(file)}${extra}`);
  await expect(page.locator("#history-chip")).toBeVisible();
  return errors;
};
const sent = (page, type) => page.evaluate((t) => window.harnessMessages.filter((m) => m.type === t), type);
const left = (locator) => locator.evaluate((el) => Math.round(el.getBoundingClientRect().left));

test("the chip takes the switch's place: the file, its repository, and × to leave", async ({ page }) => {
  await open(page);
  const chip = page.locator("#history-chip");
  await expect(chip).toHaveAttribute("aria-label", "File history: src/client.ts in acme-web");
  await expect(chip.locator(".history-dir")).toHaveText("src/");
  await expect(chip.locator(".history-base")).toHaveText("client.ts");
  await expect(chip.locator("#history-repo")).toHaveText("acme-web");
  await expect(page.locator("#modebar")).toHaveCount(0);
  // No Uncommitted switch and no Group by Repository in File History.
  await expect(page.locator(".log-header > .switch")).toBeHidden();
  await expect(page.locator("#toolbar-repos")).toBeHidden();
  // The chip sits in the header row, where the switch was: left of the filters and the actions.
  const header = await page.locator("#log-header").boundingBox();
  const box = await chip.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(header.y);
  expect(box.y + box.height).toBeLessThanOrEqual(header.y + header.height);
  expect(box.height).toBe((await page.locator("#search").boundingBox()).height);
  await page.locator("#history-close").click();
  expect(await sent(page, "exitHistory")).toHaveLength(1);
  await expect(chip).toBeHidden();
  await expect(page.locator(".log-header > .switch")).toBeVisible();
  await expect(page.locator("#toolbar-repos")).toBeVisible();
});

test("each row shows what its commit did to the file: the letter, its lines, a rename's old name", async ({ page }) => {
  await open(page);
  const rows = page.locator("#rows .row[data-index]");
  await expect(rows.first().locator(".history-change .history-status")).toHaveText("M");
  await expect(rows.first().locator(".history-change .count-added")).toHaveText(/^\+\d+$/);
  await expect(rows.first().locator(".history-change .count-deleted")).toHaveText(/^−\d+$/);
  await expect(rows.first().locator(".history-change")).toHaveAttribute("aria-label", /^Modified, \d+ lines added, \d+ deleted$/);
  const renamed = page.locator("#rows .row", { has: page.locator(".history-status.status-R") });
  await expect(renamed).toHaveCount(1);
  await expect(renamed.locator(".history-from")).toHaveText(" ← src/api-client.ts");
  // The rows before the rename name the file as it was then.
  await expect(page.locator("#rows .row .was-path").first()).toHaveText(" — src/api-client.ts");
  // A, M, D and R in their own Source Control colors.
  const color = (status) => page.locator(`#rows .row:not([aria-selected="true"]) .history-status.status-${status}`).first().evaluate((el) => getComputedStyle(el).color);
  expect(await color("R")).not.toBe(await color("M"));
  // One repository: its column is only the strip, without the name.
  for (const label of await page.locator("#rows .row .repo-label").all()) await expect(label).toBeHidden();
  const band = await rows.first().locator(".repo-band").boundingBox();
  expect(band.width).toBeLessThanOrEqual(6);
  // The row menu offers Blame at This Revision on rows that did not delete the file.
  const context = JSON.parse(await rows.first().getAttribute("data-vscode-context"));
  expect(context).toMatchObject({ webviewSection: "historyCommit", historyFileDeleted: false });
});

test("the uncommitted row sits above the commits, lined up with them, and opens the working-tree diff", async ({ page }) => {
  await open(page);
  const work = page.locator("#history-work");
  await expect(work).toBeVisible();
  await expect(work.locator(".subject")).toHaveText("Uncommitted changes");
  await expect(work.locator(".history-work-tag")).toHaveText("partly staged");
  await expect(work.locator(".history-status")).toHaveText("M");
  await expect(work.locator(".count-added")).toHaveText("+4");
  await expect(work.locator(".count-deleted")).toHaveText("−2");
  await expect(work.locator(".history-work-node")).toHaveCount(1);
  expect(await work.locator(".history-work-node").evaluate((el) => getComputedStyle(el).strokeDasharray)).not.toBe("none");
  // Above the first commit, and its columns where the commits' are.
  const first = page.locator("#rows .row[data-index]").first();
  expect((await work.boundingBox()).y).toBeLessThan((await first.boundingBox()).y);
  expect(Math.abs(await left(work.locator(".history-change")) - await left(first.locator(".history-change")))).toBeLessThanOrEqual(1);
  expect(Math.abs(await left(work.locator(".history-work-subject")) - await left(first.locator(".commit-message")))).toBeLessThanOrEqual(1);
  await work.click();
  await work.focus();
  await work.press("Enter");
  expect(await sent(page, "openHistoryWork")).toHaveLength(2);
  await expect(work).toHaveAttribute("aria-label", "Uncommitted changes, partly staged, Modified, 4 lines added, 2 deleted");
});

test("no uncommitted change, no row; and it is gone with the history", async ({ page }) => {
  await open(page, { extra: "&work=off" });
  await expect(page.locator("#rows .row[data-index]").first()).toBeVisible();
  await expect(page.locator("#history-work")).toBeHidden();
  await page.goto("/?theme=dark&state=default&history=src%2Fclient.ts");
  await expect(page.locator("#history-work")).toBeVisible();
  await page.locator("#history-close").click();
  await expect(page.locator("#history-work")).toBeHidden();
});

test("a file never committed says so, under its uncommitted row", async ({ page }) => {
  await open(page, { file: "src/new-file.ts" });
  await expect(page.locator("#empty h2")).toHaveText("Not committed yet");
  await expect(page.locator("#empty p")).toHaveText("Its history appears here once it is committed.");
  await expect(page.locator("#empty button")).toHaveCount(0);
  const work = page.locator("#history-work");
  await expect(work.locator(".history-status")).toHaveText("A");
  await expect(work.locator(".line-counts"), "an untracked file's lines are not counted").toHaveCount(0);
  await expect(work).toHaveAttribute("aria-label", "Uncommitted changes, Added");
  expect((await work.boundingBox()).y).toBeLessThan((await page.locator("#empty").boundingBox()).y);
});

test("the Repo List stays at full strength, inert, with the file's repository marked", async ({ page }) => {
  await open(page);
  const pane = page.locator("#repo-pane");
  await expect(pane).toHaveAttribute("inert", "");
  expect(await pane.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  const marked = page.locator("#repo-rows .repo-row.history-repo-row");
  await expect(marked).toHaveCount(1);
  await expect(marked.locator(".repo-name")).toHaveText("acme-web");
  expect(await marked.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  // The Repo List redraws on its own (sync counts): the mark stays.
  await page.evaluate(() => window.postMessage({ type: "sync", byRepo: { "/work/acme-api": { ahead: 1, behind: 0 } } }, "*"));
  await expect(page.locator("#repo-rows .repo-row.history-repo-row .repo-name")).toHaveText("acme-web");
});

test("a narrow Log keeps the change column and drops the author, the uncommitted row too", async ({ page }) => {
  await open(page, { width: 900, height: 700 });
  const first = page.locator("#rows .row[data-index]").first();
  await expect(first.locator(".history-change")).toBeVisible();
  await expect(first.locator(".author")).toBeHidden();
  const work = page.locator("#history-work");
  expect(Math.abs(await left(work.locator(".history-change")) - await left(first.locator(".history-change")))).toBeLessThanOrEqual(1);
  // The chip stays on the header's first line, its path cut before the file name is.
  await expect(page.locator("#history-chip .history-base")).toBeVisible();
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`${theme}: File History renders without console errors`, async ({ page }) => {
    const errors = await open(page, { theme });
    await expect(page.locator("#rows .row[data-index]").first()).toBeVisible();
    await expect(page.locator("#history-work")).toBeVisible();
    expect(errors).toEqual([]);
  });
}
