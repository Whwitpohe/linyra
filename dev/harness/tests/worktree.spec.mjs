// The Log's Uncommitted side, as GitLens draws its WIP row: per repository the files by kind over
// a meter, their names, what is staged, the branch pill and the edit time; the header sums the
// counts. Mock work: dev/harness/mock/worktree.ts, built with the host's own model.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 1600, height = 400, state = "default", locale = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/${locale ? `index.${locale}.html` : ""}?theme=${theme}&state=${state}`);
  await expect(page.locator("#rows .row").first()).toBeVisible();
  await page.click("#mode-work");
  await expect(page.locator(".work-row").first()).toBeVisible();
  return errors;
};
const row = (page, repo) => page.locator(`.work-row[data-repo="/work/${repo}"]`);

test("a row: repository, files by kind, their names, the staged tag, the branch pill, the edit time", async ({ page }) => {
  await open(page);
  await expect(page.locator(".work-row")).toHaveCount(3);
  const web = row(page, "acme-web");
  await expect(web.locator(".chip")).toHaveText("acme-web");
  await expect(web.locator(".work-counts .count-added")).toHaveText("+1");
  await expect(web.locator(".work-counts .count-modified")).toHaveText("2");
  await expect(web.locator(".work-counts .counts")).toHaveAttribute("aria-label", "1 new, 2 modified");
  await expect(web.locator(".work-preview")).toHaveText("notes.md, src/app.ts, src/new.ts");
  await expect(web.locator(".work-tag")).toHaveText(["1 staged"]);
  await expect(web.locator(".work-pill")).toHaveText("develop↑1 ↓2");
  await expect(web.locator(".work-pill")).toHaveAttribute("title", "develop · origin/develop · 2 commits to pull from its upstream, 1 commit not pushed");
  await expect(web.locator(".work-edited")).toHaveText("edited 2m ago");
  // No "N new" tag: the counts say it.
  await expect(page.locator(".work-tag", { hasText: "new" })).toHaveCount(0);
  await expect(page.locator(".work-preview", { hasText: "files ·" })).toHaveCount(0);
});

test("the pill: a cloud in step with the upstream, unpublished without one, the commit when detached", async ({ page }) => {
  await open(page, { state: "adjacent" });
  const api = row(page, "acme-api").locator(".work-pill");
  await expect(api.locator(".pill-part")).toHaveCount(2);
  await expect(api.locator(".pill-remote .pill-label")).toBeHidden();
  await expect(api.locator(".pill-status")).toHaveCount(0);
  await expect(api).toHaveAttribute("title", "main · up to date with origin/main");
  await expect(row(page, "acme-libs").locator(".work-pill")).toHaveText("feature/buttonunpublished");
  await expect(row(page, "acme-libs").locator(".work-tag")).toHaveText(["all staged"]);
  await expect(row(page, "acme-worker").locator(".work-pill")).toHaveAttribute("title", "release-1.4 · its upstream origin/release-1.4 is gone");
  const infra = row(page, "acme-infra").locator(".work-pill");
  await expect(infra).toHaveText("4f2a9c1");
  await expect(infra.locator(".pill-detached")).toHaveCount(1);
  await expect(infra).toHaveAttribute("title", "HEAD detached at 4f2a9c1");
  await expect(row(page, "acme-docs").locator(".work-counts")).toHaveText(/\+143.*2.*−1/);
  // Right-click on the pill opens the row's menu: the pill brings no context of its own.
  await expect(page.locator(".work-pill[data-vscode-context]")).toHaveCount(0);
  const ctx = JSON.parse(await row(page, "acme-api").getAttribute("data-vscode-context"));
  expect(ctx.webviewSection).toBe("uncommitted");
});

test("columns line up across rows; the meter hangs under the counts, as wide as the widest", async ({ page }) => {
  await open(page, { state: "adjacent" });
  const rows = page.locator(".work-row");
  const lefts = async (sel) => rows.locator(sel).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  for (const sel of [".work-counts", ".work-preview", ".meter"]) expect(new Set(await lefts(sel)).size, sel).toBe(1);
  const rights = await rows.locator(".work-pill").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().right)));
  expect(new Set(rights).size, "the pills end at one edge").toBe(1);
  const widths = await rows.locator(".meter").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
  expect(new Set(widths).size).toBe(1);
  expect(widths[0]).toBeGreaterThan(20);
  for (const r of await rows.all()) {
    const counts = await r.locator(".work-counts .counts").boundingBox();
    const meter = await r.locator(".meter").boundingBox();
    const box = await r.boundingBox();
    expect(meter.y).toBeGreaterThanOrEqual(counts.y + counts.height);
    expect(meter.y + meter.height).toBeLessThanOrEqual(box.y + box.height);
  }
  // Its parts: each kind's share of the files, in order.
  await expect(row(page, "acme-web").locator(".meter i")).toHaveCount(2);
  expect(await row(page, "acme-web").locator(".meter i").evaluateAll((els) => els.map((el) => el.className))).toEqual(["added", "modified"]);
  expect(await row(page, "acme-worker").locator(".meter i").evaluateAll((els) => els.map((el) => el.className))).toEqual(["modified", "renamed"]);
});

test("the header sums the counts; lines and repositories are in its tooltip; the Commits side has none", async ({ page }) => {
  await open(page);
  const totals = page.locator("#work-totals .counts");
  await expect(totals.locator(".count-added")).toHaveText("+1");
  await expect(totals.locator(".count-modified")).toHaveText("3");
  await expect(totals.locator(".count-deleted")).toHaveText("−1");
  await expect(totals).toHaveAttribute("title", "1 new, 3 modified, 1 deleted\n3 repositories · 22 lines added, 44 deleted");
  await page.click("#mode-commits");
  await expect(page.locator("#work-totals")).toBeEmpty();
  await expect(page.locator("#work-totals")).toBeHidden();
});

test("↑/↓ move the selection; a narrow Log drops the time, and no row runs past its edge", async ({ page }) => {
  await open(page, { state: "adjacent" });
  await page.locator("#worklist").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('.work-row[aria-selected="true"]')).toHaveCount(1);
  await expect(page.locator(".work-row").nth(1)).toHaveAttribute("aria-selected", "true");
  for (const width of [1250, 1000, 800]) {
    await page.setViewportSize({ width, height: 400 });
    const log = await page.locator(".log").boundingBox();
    if (log.width <= 760) await expect(page.locator(".work-edited").first()).toBeHidden();
    const overflow = await page.locator(".work-row").evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
    expect(overflow, `${width}px`).toBe(0);
    await expect(page.locator(".work-row .work-counts .counts").first()).toBeVisible();
  }
});

test("zh-cn: the tag, the pill and the time are translated", async ({ page }) => {
  await open(page, { locale: "zh-cn" });
  await expect(row(page, "acme-web").locator(".work-tag")).toHaveText(["1 个已暂存"]);
  await expect(row(page, "acme-libs").locator(".work-pill .pill-status")).toHaveText("未推送到远程");
  await expect(row(page, "acme-api").locator(".work-pill")).toHaveAttribute("title", "main · 已与 origin/main 同步");
  await expect(row(page, "acme-web").locator(".work-edited")).toHaveText("2 分钟前编辑");
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`${theme}: the Uncommitted side renders its icons and logs no errors`, async ({ page }) => {
    const errors = await open(page, { theme, state: "adjacent" });
    await expect(page.locator(".work-row .pill-icon")).toHaveCount(7);
    await expect(page.locator(".work-row .count-icon").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}
