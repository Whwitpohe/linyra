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
    // Arrows walk the choices at once; the read waits until they stop, so passing one reads nothing.
    await page.keyboard.press("ArrowRight");
    await expect(range.getByRole("radio", { name: "All" })).toHaveAttribute("aria-checked", "true");
    await expect(range.getByRole("radio", { name: "All" })).toBeFocused();
    await expect.poll(async () => (await messages(page, "range")).map((m) => m.range)).toEqual(["all"]);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(range.getByRole("radio", { name: "3 months" })).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await messages(page, "range")).map((m) => m.range)).toEqual(["all", "3m"]);
    await range.getByRole("radio", { name: "All" }).click();
    await expect.poll(async () => (await messages(page, "range")).length).toBe(3);
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
    for (const name of await page.locator(".insights-tab span").all()) await expect(name).toBeHidden();
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

test.describe("Files and Commits", () => {
  for (const theme of THEMES) {
    test(`Files: a tile per file, colored by its type, framed by its folders, in ${theme}`, async ({ page }) => {
      const errors = await open(page, { theme, tab: "files" });
      const map = page.locator("#files-map");
      await expect(map.locator(".tile.kind-repo")).toHaveCount(3);
      await expect(map.locator(".tile.kind-file").first()).toBeVisible();
      await expect(page.locator("#files-crumbs .crumb.current")).toHaveText("Ticked repositories (3)");
      await expect(page.locator("#files-legend .legend-item")).toHaveCount(8);
      await expect(page.locator("#files-legend .legend-item").first()).toHaveText(".json");
      // The biggest file type's tiles share one color, a theme color, unlike Other's.
      const json = await map.locator(".tile.kind-file.type-0").first().evaluate((el) => getComputedStyle(el).backgroundColor);
      const other = await map.locator(".tile.kind-file.type-other").first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(json).not.toBe(other);
      // Tiles fill the map without overlapping their siblings.
      const box = await map.boundingBox();
      const tiles = await map.locator(".tile.depth-1").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()));
      const area = tiles.reduce((s, r) => s + r.width * r.height, 0);
      expect(area / (box.width * box.height)).toBeGreaterThan(0.97);
      await expect(page.locator("#range")).toBeHidden();
      expect(errors).toEqual([]);
    });

    test(`Commits: hot files stand out, every tile names its count, in ${theme}`, async ({ page }) => {
      const errors = await open(page, { theme, tab: "commits" });
      const map = page.locator("#commits-map");
      await expect(map.locator(".tile.kind-file.heat-3").first()).toBeVisible();
      const hot = await map.locator(".tile.kind-file.heat-3").first().evaluate((el) => getComputedStyle(el).backgroundColor);
      const cold = await map.locator(".tile.kind-file.heat-0").first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(hot).not.toBe(cold);
      await expect(map.locator(".tile.kind-file.heat-3 .tile-value").first()).toHaveText(/^\d+ commits$/);
      await expect(page.locator("#commits-legend .legend-label")).toHaveText("Commits per file");
      await expect(page.locator("#range")).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test("a folder opens on click, a crumb goes back; a file is chosen and its strip acts on it", async ({ page }) => {
    await open(page, { tab: "files" });
    const map = page.locator("#files-map");
    await map.locator(".tile.frame.kind-repo", { hasText: "acme-api" }).locator(".tile-name").first().click();
    await expect(page.locator("#files-crumbs .crumb.current")).toHaveText("acme-api");
    expect((await messages(page, "drill")).at(-1)).toEqual({ type: "drill", tab: "files", path: ["/work/acme-api"] });
    await map.locator(".tile.kind-file", { hasText: "go.sum" }).click();
    const strip = page.locator("#files-strip");
    await expect(strip).toBeVisible();
    await expect(strip.locator(".strip-path")).toHaveText("go.sum");
    await expect(strip.locator(".strip-value")).toHaveText("84 KB");
    await expect(map.locator(".tile.selected")).toHaveCount(1);
    await strip.getByRole("button", { name: "Open File" }).click();
    expect((await messages(page, "openFile")).at(-1)).toEqual({ type: "openFile", repoId: "/work/acme-api", path: "go.sum" });
    await strip.getByRole("button", { name: "Visual History" }).click();
    expect((await messages(page, "visualHistory")).at(-1)).toEqual({ type: "visualHistory", repoId: "/work/acme-api", path: "go.sum", folder: false });
    await expect(page.getByRole("tab", { name: "Visual History" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#scope option:checked")).toHaveText("acme-api › go.sum");
    await page.getByRole("tab", { name: "Files" }).click();
    await page.locator("#scope").selectOption({ label: "Ticked repositories (3)" });
    await expect(page.locator("#files-crumbs .crumb.current")).toHaveText("Ticked repositories (3)");
  });

  test("the keyboard: arrows move between tiles, Enter opens a folder, Backspace goes back up", async ({ page }) => {
    await open(page, { tab: "commits" });
    const map = page.locator("#commits-map");
    await expect(map.locator(".tile").first()).toBeVisible();
    await map.focus();
    const status = page.locator("#insights-status");
    await expect(status).toHaveText(/^acme-api, \d+ commits in \d+ files$/);
    await expect(page.locator(".tile-ring")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("#commits-crumbs .crumb.current")).toHaveText("acme-api");
    await page.keyboard.press("ArrowRight");
    await expect(status).not.toHaveText(/^acme-api,/);
    await page.keyboard.press("Backspace");
    await expect(page.locator("#commits-crumbs .crumb.current")).toHaveText("Ticked repositories (3)");
    // A file: Enter chooses it.
    for (let i = 0; i < 12 && !/\.\w+, \d+ commits?$/.test(await status.textContent()); i++) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page.locator("#commits-strip")).toBeVisible();
  });

  test("narrow: the map fills the width; nothing scrolls sideways", async ({ page }) => {
    const errors = await open(page, { tab: "files", width: 420, height: 600, theme: "hc-light" });
    await expect(page.locator("#files-map .tile").first()).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    const box = await page.locator("#files-map").boundingBox();
    expect(box.width).toBeGreaterThan(380);
    expect(errors).toEqual([]);
  });

  test("empty and failing reads say so; Chinese", async ({ page }) => {
    await open(page, { tab: "files", query: "&state=empty" });
    await expect(page.locator("#files-empty")).toHaveText("No tracked files here.");
    await open(page, { tab: "commits", query: "&state=error" });
    await expect(page.locator("#commits-notes")).toContainText("acme-libs could not be read: fatal: not a valid object name HEAD");
    await open(page, { tab: "files", page: "insights.zh-cn.html" });
    await expect(page.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#files-crumbs .crumb-total")).toHaveText(/^1\.1 MB，共 53 个文件$/);
  });
});

test.describe("Repository Health", () => {
  for (const theme of THEMES) {
    test(`a row per repository, a column per check, the selected row's details, in ${theme}`, async ({ page }) => {
      const errors = await open(page, { theme, tab: "health" });
      const rows = page.locator("#health-table tbody tr");
      await expect(rows).toHaveCount(3);
      await expect(page.locator("#health-table thead th")).toHaveCount(10);
      await expect(rows.first()).toHaveAttribute("aria-selected", "true");
      await expect(rows.first().locator(".col-count")).toHaveText("6");
      await expect(page.locator(".health-details-title")).toHaveText("acme-web");
      await expect(page.locator(".health-item")).toHaveCount(7);
      const ok = await rows.nth(1).locator(".status-ok .cell-icon").first().evaluate((el) => getComputedStyle(el).color);
      const suggest = await rows.first().locator(".status-suggest .cell-icon").first().evaluate((el) => getComputedStyle(el).color);
      expect(ok).not.toBe(suggest);
      await expect(page.locator("#health-toolbar .health-summary")).toHaveText("6 suggestions in 3 repositories");
      expect(errors).toEqual([]);
    });
  }

  test("each check's button and Optimize Selected post the write they ask for; nothing writes here", async ({ page }) => {
    await open(page, { tab: "health" });
    const optimize = page.getByRole("button", { name: "Optimize Selected (1)…" });
    await expect(optimize).toBeEnabled();
    await optimize.click();
    const details = page.locator("#health-details");
    await details.getByRole("button", { name: "Write Commit-Graph" }).click();
    // By its label: "untracked cache" is also in Many files' explanation.
    const item = (label) => details.locator(".health-item").filter({ has: page.locator(".health-item-label", { hasText: new RegExp(`^${label}$`) }) });
    await item("Untracked cache").getByRole("button", { name: "Turn On" }).click();
    await details.getByRole("button", { name: "Run Maintenance…" }).click();
    await details.getByRole("button", { name: "Copy Command" }).click();
    expect((await messages(page, "health")).map(({ action, repoIds, key, value }) => [action, repoIds.join(), key, value])).toEqual([
      ["optimize", "/work/acme-web", undefined, undefined],
      ["commitGraph", "/work/acme-web", undefined, undefined],
      ["config", "/work/acme-web", "core.untrackedCache", true],
      ["maintenance", "/work/acme-web", undefined, undefined],
      ["copy", "/work/acme-web", undefined, undefined],
    ]);
    // Unticked, there is nothing to optimize.
    await page.getByRole("checkbox", { name: "Optimize acme-web" }).click();
    await expect(page.getByRole("button", { name: "Optimize Selected…" })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Tick every repository with something to optimize" }).click();
    await expect(page.getByRole("button", { name: "Optimize Selected (1)…" })).toBeEnabled();
  });

  test("the keyboard: ↑/↓ choose a repository, Enter goes to its first button", async ({ page }) => {
    await open(page, { tab: "health" });
    await page.locator("#health-table tbody tr").first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("#health-table tbody tr").nth(1)).toBeFocused();
    await expect(page.locator(".health-details-title")).toHaveText("acme-api");
    await page.keyboard.press("End");
    await expect(page.locator(".health-details-title")).toHaveText("acme-libs");
    await page.keyboard.press("Home");
    await page.keyboard.press("Space");
    await expect(page.getByRole("checkbox", { name: "Optimize acme-web" })).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Enter");
    await expect(page.locator("#health-details").getByRole("button", { name: "Write Commit-Graph" })).toBeFocused();
  });

  test("on Linux git has no built-in monitor: no button, and it says why", async ({ page }) => {
    await open(page, { tab: "health", query: "&platform=linux" });
    const fs = page.locator(".health-item").filter({ has: page.locator(".health-item-label", { hasText: /^File system monitor$/ }) });
    await expect(fs).toContainText("git's built-in monitor runs on Windows and macOS only.");
    await expect(fs.getByRole("button")).toHaveCount(0);
  });

  test("narrow: the table scrolls sideways inside its box, the repository stays in view", async ({ page }) => {
    const errors = await open(page, { tab: "health", width: 420, height: 700, theme: "hc-dark" });
    await expect(page.locator("#health-table tbody tr")).toHaveCount(3);
    expect(await noOverflow(page)).toBe(true);
    const wrap = page.locator(".health-table-wrap");
    expect(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await wrap.evaluate((el) => { el.scrollLeft = 400; });
    const repo = await page.locator("#health-table tbody tr").first().locator(".col-repo").boundingBox();
    const box = await wrap.boundingBox();
    expect(repo.x).toBeGreaterThanOrEqual(box.x);
    expect(repo.x).toBeLessThan(box.x + 60);
    expect(errors).toEqual([]);
  });

  test("Chinese", async ({ page }) => {
    await open(page, { tab: "health", page: "insights.zh-cn.html" });
    await expect(page.getByRole("tab", { name: "健康" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "优化所选（1）…" })).toBeVisible();
    await expect(page.locator("#health-details").getByRole("button", { name: "写入 Commit-Graph" })).toBeVisible();
  });
});

test.describe("The tabs", () => {
  test("arrows move between the tabs; Enter or Space shows one, so passing a tab reads nothing", async ({ page }) => {
    await open(page);
    await page.getByRole("tab", { name: "Visual History" }).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Commits" })).toBeFocused();
    await expect(page.getByRole("tab", { name: "Visual History" })).toHaveAttribute("aria-selected", "true");
    expect(await messages(page, "tab")).toEqual([]);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: "Commits" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#panel-commits")).toBeVisible();
    await page.keyboard.press("End");
    await page.keyboard.press("Space");
    await expect(page.getByRole("tab", { name: "Health" })).toHaveAttribute("aria-selected", "true");
    expect((await messages(page, "tab")).map((m) => m.tab)).toEqual(["commits", "health"]);
  });

  test("the keyboard's bubble stays focused when the same answer comes again", async ({ page }) => {
    await open(page);
    await expect(page.locator("#history-chart circle.bubble").first()).toBeVisible();
    await page.locator("#history-chart").focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    const status = await page.locator("#insights-status").textContent();
    const focused = await page.locator("#history-chart circle.bubble.focused").getAttribute("data-i");
    // The host posts the same commits again (a repository was read again, unchanged).
    await page.evaluate(() => window.insightsMessages.length);
    await page.locator("#refresh").click();
    await expect(page.locator("#history-chart circle.bubble.focused")).toHaveCount(1);
    expect(await page.locator("#history-chart circle.bubble.focused").getAttribute("data-i")).toBe(focused);
    expect(status).toMatch(/ — /);
  });
});
