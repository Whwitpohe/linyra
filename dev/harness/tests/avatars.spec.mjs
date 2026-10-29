// Avatars in the Log: the webview tells the host whose rows are on screen (it asks only for those),
// and each batch the host sends redraws the rows on screen once. The harness answers like the host
// (dev/harness/mock/avatars.ts): a picture for dana, none for rin.
import { expect, test } from "@playwright/test";

const open = async (page, state = "default") => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1400, height: 420 });
  await page.goto(`/?theme=dark&state=${state}`);
  await expect(page.locator("#rows .row[data-index]").first()).toBeVisible();
  return errors;
};
const reports = (page) => page.evaluate(() => window.harnessMessages.filter((m) => m.type === "visibleAuthors"));
/** Every row in the DOM: its repository (from its menu context) and its author's address (the mock's name@example.com). */
const onScreen = (page) => page.locator("#rows .row[data-index]").evaluateAll((rows) => [...new Set(rows.map((row) =>
  `${JSON.parse(row.dataset.vscodeContext).repoId} ${row.querySelector(".author").textContent}@example.com`))].sort());

test("the Log names the authors of the rows on screen, once they settle", async ({ page }) => {
  // 68 repositories: a scroll brings rows of other repositories.
  const errors = await open(page, "many");
  await expect.poll(async () => (await reports(page)).length).toBe(1);
  const [report] = await reports(page);
  expect(report.authors.map((a) => `${a.repoId} ${a.email}`).sort()).toEqual(await onScreen(page));
  // The answer redraws the rows; the same authors are on screen, so nothing is asked again.
  await page.waitForTimeout(900);
  expect((await reports(page)).length).toBe(1);
  // A fast scroll through the list asks nothing on the way; where it stops is asked once.
  await page.locator("#list").evaluate(async (list) => {
    for (let i = 1; i <= 10; i++) {
      list.scrollTop = (list.scrollHeight * i) / 10;
      await new Promise((r) => setTimeout(r, 30));
    }
  });
  await expect.poll(async () => (await reports(page)).length).toBe(2);
  await page.waitForTimeout(600);
  expect((await reports(page)).length).toBe(2);
  expect((await reports(page))[1].authors.map((a) => `${a.repoId} ${a.email}`).sort()).toEqual(await onScreen(page));
  expect(errors).toEqual([]);
});

test("a batch of avatars redraws the rows on screen once; the same batch again changes nothing", async ({ page }) => {
  const errors = await open(page);
  // Count the list's repaints that add rows, and mark a row to see that it was built again.
  await page.evaluate(() => {
    const rows = document.getElementById("rows");
    window.repaints = 0;
    new MutationObserver((records) => { if (records.some((r) => r.addedNodes.length > 0)) window.repaints++; }).observe(rows, { childList: true });
    rows.querySelector(".row[data-index]").dataset.marked = "1";
    window.avatarBatches = 0;
    window.addEventListener("message", (e) => { if (e.data?.type === "avatars") window.avatarBatches++; });
  });
  await expect.poll(() => page.evaluate(() => window.avatarBatches)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.repaints)).toBe(1);
  await expect(page.locator("#rows .row[data-marked]")).toHaveCount(0);
  // Graph discs (authorDiscSvg) draw dana's picture, rin's initial.
  if (await page.locator("#rows .author-disc").count() > 0) await expect(page.locator("#rows .author-disc-image").first()).toBeAttached();

  const batch = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    return { "dana@example.com": canvas.toDataURL("image/png") };
  });
  await page.evaluate((byEmail) => window.postMessage({ type: "avatars", byEmail }, "*"), batch);
  await expect.poll(() => page.evaluate(() => window.repaints)).toBe(2);
  await page.evaluate((byEmail) => window.postMessage({ type: "avatars", byEmail }, "*"), batch);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.repaints)).toBe(2);
  // Not a picture: ignored.
  await page.evaluate(() => window.postMessage({ type: "avatars", byEmail: { "rin@example.com": "javascript:alert(1)" } }, "*"));
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.repaints)).toBe(2);
  // The settings changed: the avatars sent before are dropped, in one more redraw.
  await page.evaluate(() => window.postMessage({ type: "avatars", byEmail: {}, reset: true }, "*"));
  await expect.poll(() => page.evaluate(() => window.repaints)).toBe(3);
  expect(errors).toEqual([]);
});
