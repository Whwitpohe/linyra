// Linyra Insights (src/webview/insights) against the harness's host (dev/harness/insightsShim.ts):
// each tab in the four themes and at a narrow width, its keyboard paths and the messages it posts.
import { expect, test } from "@playwright/test";

const THEMES = ["dark", "light", "hc-dark", "hc-light"];

const open = async (page, { theme = "dark", tab = "history", width = 1200, height = 640, query = "", page: file = "insights.html" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/${file}?theme=${theme}&tab=${tab}${query}`);
  return errors;
};
const messages = (page, type) => page.evaluate((t) => window.insightsMessages.filter((m) => m.type === t), type);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe("Visual History", () => {
  for (const theme of THEMES) {
    test(`draws a bubble per commit and an author row each, in ${theme}`, async ({ page }) => {
      const errors = await open(page, { theme });
      const bubbles = page.locator("#history-chart circle.bubble");
      await expect(bubbles.first()).toBeVisible();
      const count = await bubbles.count();
      expect(count).toBeGreaterThan(40);
      await expect(page.locator("#history-summary")).toHaveText(new RegExp(`^${count} commits by \\d+ authors in 3 repositories`));
      await expect(page.locator(".history-author")).toHaveCount(4);
      // Each bubble's fill and ring come from its repository's accent, a theme color.
      const paint = await bubbles.first().evaluate((el) => { const s = getComputedStyle(el); return { fill: s.fill, stroke: s.stroke }; });
      expect(paint.fill).not.toBe("none");
      expect(paint.stroke).not.toBe("none");
      expect(paint.stroke).not.toBe(paint.fill);
      await expect(page.locator(".legend-item")).toHaveCount(3);
      expect(errors).toEqual([]);
    });
  }

  test("hovering a bubble shows its commit; clicking it asks the Log to show it", async ({ page }) => {
    await open(page);
    const bubble = page.locator("#history-chart circle.bubble").last();
    await bubble.hover();
    const tip = page.locator("#insights-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip.locator(".tip-subject")).not.toBeEmpty();
    await expect(tip.locator(".tip-sha")).toHaveText(/^[0-9a-f]{7}$/);
    await expect(tip.locator(".tip-repo")).toHaveText(/^acme-(web|api|libs)$/);
    await bubble.click();
    const [reveal] = await messages(page, "reveal");
    expect(reveal.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(reveal.repoId).toMatch(/^\/work\/acme-/);
    await page.mouse.move(2, 2);
    await expect(tip).toBeHidden();
  });

  test("the keyboard walks the commits and Enter shows one in the Log", async ({ page }) => {
    await open(page);
    await expect(page.locator("#history-chart circle.bubble").first()).toBeVisible();
    await page.locator("#history-chart").focus();
    const status = page.locator("#insights-status");
    await expect(status).toHaveText(/ — dana, acme-/);
    const newest = await status.textContent();
    await page.keyboard.press("ArrowLeft");
    await expect(status).not.toHaveText(newest);
    await page.keyboard.press("ArrowDown");
    await expect(status).toHaveText(/ — rin, /);
    await expect(page.locator("#history-chart circle.bubble.focused")).toHaveCount(1);
    await expect(page.locator("#insights-tooltip")).toBeVisible();
    await page.keyboard.press("Enter");
    expect(await messages(page, "reveal")).toHaveLength(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("#insights-tooltip")).toBeHidden();
  });

  test("Range and Color by are radio groups: a click or an arrow key chooses", async ({ page }) => {
    await open(page);
    const range = page.locator("#range");
    await expect(range.getByRole("radio", { name: "3 months" })).toHaveAttribute("aria-checked", "true");
    await range.getByRole("radio", { name: "1 year" }).click();
    await expect(range.getByRole("radio", { name: "1 year" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowRight");
    await expect(range.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
    expect((await messages(page, "range")).map((m) => m.range)).toEqual(["1y", "all"]);
    const before = await page.locator("#history-chart circle.bubble").count();
    expect(before).toBeGreaterThan(200);

    await page.locator("#color-by").getByRole("radio", { name: "Author" }).click();
    expect((await messages(page, "colorBy")).map((m) => m.colorBy)).toEqual(["author"]);
    await expect(page.locator("#history-legend")).toBeHidden();
    // Colored by author, a row's bubbles share its color.
    const rows = await page.locator("#history-chart circle.bubble").evaluateAll((els) => {
      const byRow = new Map();
      for (const el of els) {
        const cy = el.getAttribute("cy"), accent = [...el.classList].find((c) => c.startsWith("accent-"));
        byRow.set(cy, (byRow.get(cy) ?? new Set()).add(accent));
      }
      return [...byRow.values()].map((s) => s.size);
    });
    expect(rows.every((n) => n === 1)).toBe(true);
  });

  test("the scope picks one repository", async ({ page }) => {
    await open(page);
    await page.locator("#scope").selectOption({ label: "acme-api" });
    await expect(page.locator(".legend-item")).toHaveCount(1);
    await expect(page.locator(".legend-item")).toHaveText("acme-api");
    expect((await messages(page, "scope"))[0].scope).toEqual({ kind: "repo", repoId: "/work/acme-api" });
  });

  test("a file scope is named in the picker", async ({ page }) => {
    await open(page, { query: "&path=src/client.ts" });
    await expect(page.locator("#scope option:checked")).toHaveText("acme-web › src/client.ts");
  });

  test("empty, failing and cut-off reads say so", async ({ page }) => {
    await open(page, { query: "&state=empty" });
    await expect(page.locator("#history-empty")).toHaveText("No commits in this range. Choose a longer range above.");
    await expect(page.locator("#history-chart")).toBeHidden();
    await open(page, { query: "&state=error" });
    await expect(page.locator("#history-notes")).toContainText("acme-libs could not be read: fatal: bad object HEAD");
    await open(page, { query: "&state=many&range=all" });
    await expect(page.locator("#history-notes")).toContainText("acme-web: only its latest 5,000 commits in this range are drawn.");
    await expect(page.locator(".history-author")).toHaveCount(6);
  });

  test("narrow: the discs stay, names move to their titles, nothing scrolls sideways", async ({ page }) => {
    const errors = await open(page, { width: 420, height: 560, theme: "hc-dark" });
    await expect(page.locator("#history-chart circle.bubble").first()).toBeVisible();
    await expect(page.locator(".history-author-name")).toHaveCount(0);
    await expect(page.locator(".history-author").first()).toHaveAttribute("title", /^dana <dana@example\.com> · \d+ commits$/);
    await expect(page.locator(".insights-tab span")).toBeHidden();
    await expect(page.getByRole("tab", { name: "Visual History" })).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("Chinese", async ({ page }) => {
    await open(page, { page: "insights.zh-cn.html" });
    await expect(page.getByRole("tab", { name: "可视化历史" })).toBeVisible();
    await expect(page.locator("#range").getByRole("radio", { name: "3 个月" })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator("#history-summary")).toHaveText(/^\d+ 个提交，4 位作者，3 个仓库/);
  });
});
