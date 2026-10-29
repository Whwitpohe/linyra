// The one tree of changed files (src/webview/ui/fileTree.ts) in the Changes view and in Compare's
// sides: the same rows, keys, mouse, filter and looks in both, a long tree drawing only the rows on
// screen, a narrow tree, and every theme.
import { expect, test } from "@playwright/test";

const errorsOf = (page) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  return errors;
};
const changes = async (page, { theme = "dark", state = "default", width = 520, height = 760 } = {}) => {
  const errors = errorsOf(page);
  await page.setViewportSize({ width, height });
  await page.goto(`/changes.html?theme=${theme}&state=${state}`);
  await expect(page.locator("#file-tree .ftree-row").nth(2)).toBeVisible();
  return errors;
};
const compare = async (page, { theme = "dark", width = 1300, files = "kinds" } = {}) => {
  const errors = errorsOf(page);
  await page.setViewportSize({ width, height: 600 });
  await page.goto(`/repos.html?theme=${theme}&files=${files}`);
  await expect(page.locator("#compare-left-tree .ftree-row").nth(2)).toBeVisible();
  return errors;
};
const row = (page, tree, name) => page.locator(`${tree} .ftree-row`, { has: page.locator(".ftree-label", { hasText: name }) });
const label = (locator) => locator.locator(".ftree-label");
const sent = (page, key, type) => page.evaluate(([k, t]) => window[k].filter((m) => m.type === t), [key, type]);
const focusedLabel = (page, tree) => page.locator(`${tree} .ftree-row.focused .ftree-label`);
const selectedLabels = (page, tree) => page.locator(`${tree} .ftree-row.selected .ftree-label`).allTextContents();

test("both views draw a row from the same parts, at the same indent and height", async ({ page }) => {
  const errors = await changes(page);
  const measure = (tree) => page.locator(`${tree} .ftree-row`).evaluateAll((rows) => rows.slice(0, 4).map((r) => ({
    level: r.getAttribute("aria-level"), pad: getComputedStyle(r).paddingLeft, height: r.getBoundingClientRect().height,
    parts: [...r.children].map((c) => c.className.split(" ")[0]).join(" "),
  })));
  const fromChanges = await measure("#file-tree");
  await compare(page);
  const fromCompare = await measure("#compare-left-tree");
  // A folder at the top, a file under it: twisty, icon, name (old path, end), letter.
  expect(fromChanges[0]).toEqual({ level: "1", pad: "8px", height: 25, parts: "ftree-twisty ftree-icon ftree-label ftree-end" });
  expect(fromCompare[0]).toEqual({ level: "1", pad: "8px", height: 25, parts: "ftree-twisty ftree-icon ftree-label ftree-end" });
  const fileOf = (rows) => rows.find((r) => r.level === "2" && r.parts.includes("file-status"));
  expect(fileOf(fromCompare)).toMatchObject({ pad: "22px", height: 25 });
  expect(fromChanges.find((r) => r.level === "3")).toMatchObject({ pad: "36px", height: 25, parts: "ftree-twisty ftree-icon ftree-label ftree-old-path ftree-end file-status" });
  expect(errors).toEqual([]);
});

test("keys: ↑ ↓ Home End PageUp PageDown, ← → on folders, Enter and Space, Ctrl+A", async ({ page }) => {
  await changes(page);
  const tree = page.locator("#file-tree");
  await tree.focus();
  // The tree takes the focus on its first row, selecting nothing; ↓ goes to the second.
  await expect(focusedLabel(page, "#file-tree")).toHaveText("dist");
  expect(await selectedLabels(page, "#file-tree")).toEqual([]);
  await page.keyboard.press("ArrowDown");
  await expect(focusedLabel(page, "#file-tree")).toHaveText("assets");
  expect(await selectedLabels(page, "#file-tree")).toEqual(["assets"]);
  await page.keyboard.press("End");
  await expect(focusedLabel(page, "#file-tree")).toHaveText("logo.png");
  await page.keyboard.press("Home");
  await expect(focusedLabel(page, "#file-tree")).toHaveText("dist");
  await page.keyboard.press("PageDown");
  const paged = await page.locator("#file-tree .ftree-row.focused").getAttribute("aria-posinset");
  expect(Number(paged)).toBeGreaterThan(1);
  await page.keyboard.press("PageUp");
  await expect(focusedLabel(page, "#file-tree")).toHaveText("dist");
  // → on an open folder goes to its first row; ← on a file goes to its folder; ← on an open folder closes it.
  await page.keyboard.press("ArrowRight");
  await expect(focusedLabel(page, "#file-tree")).toHaveText("assets");
  await page.keyboard.press("ArrowRight");
  await expect(focusedLabel(page, "#file-tree")).toHaveText(/^AccountDialog/);
  await page.keyboard.press("ArrowLeft");
  await expect(focusedLabel(page, "#file-tree")).toHaveText("assets");
  await page.keyboard.press("ArrowLeft");
  await expect(row(page, "#file-tree", "assets")).toHaveAttribute("aria-expanded", "false");
  await expect(row(page, "#file-tree", "AccountDialog")).toHaveCount(0);
  // → opens it again; Space and Enter toggle a folder.
  await page.keyboard.press("ArrowRight");
  await expect(row(page, "#file-tree", "assets")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press(" ");
  await expect(row(page, "#file-tree", "assets")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(row(page, "#file-tree", "assets")).toHaveAttribute("aria-expanded", "true");
  // Enter on a file opens its diff.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await sent(page, "changesMessages", "open")).at(-1)?.id).toBe("asset-0");
  // Shift+↓ extends; Ctrl+↓ moves the focus alone; Ctrl+Space adds the focused row.
  await page.keyboard.press("Shift+ArrowDown");
  expect(await selectedLabels(page, "#file-tree")).toEqual([expect.stringMatching(/^AccountDialog/), expect.stringMatching(/^ActivityDetail/)]);
  await page.keyboard.press("Control+ArrowDown");
  await page.keyboard.press("Control+ArrowDown");
  await expect(focusedLabel(page, "#file-tree")).toHaveText(/^DownloadView/);
  expect((await selectedLabels(page, "#file-tree")).length).toBe(2);
  await page.keyboard.press("Control+ ");
  expect((await selectedLabels(page, "#file-tree")).length).toBe(3);
  await expect.poll(async () => (await sent(page, "changesMessages", "selection")).at(-1)?.ids).toEqual(["asset-0", "asset-1", "asset-3"]);
  await page.keyboard.press("Control+a");
  expect((await selectedLabels(page, "#file-tree")).length).toBe(16);
});

test("type-to-find goes to the next name starting with the letters typed; the same letter again cycles", async ({ page }) => {
  await compare(page);
  await page.locator("#compare-left-tree").focus();
  await page.keyboard.type("up");
  await expect(focusedLabel(page, "#compare-left-tree")).toHaveText("upload.ts");
  await page.waitForTimeout(800);
  // From upload.ts, "l" is the next name with an l, below it; "l" again goes around to the top.
  await page.keyboard.type("l");
  await expect(focusedLabel(page, "#compare-left-tree")).toHaveText("logo.png");
  await page.keyboard.type("l");
  await expect(focusedLabel(page, "#compare-left-tree")).toHaveText("limits.ts");
  await page.waitForTimeout(800);
  // "o": old-auth.ts; "oo": nothing else starts with o, so it stays.
  await page.keyboard.type("o");
  await expect(focusedLabel(page, "#compare-left-tree")).toHaveText("old-auth.ts");
  await page.keyboard.type("o");
  await expect(focusedLabel(page, "#compare-left-tree")).toHaveText("old-auth.ts");
});

test("mouse: a folder's row toggles it, its twisty toggles it alone, Shift and Ctrl pick several, right-click keeps them", async ({ page }) => {
  await compare(page);
  const src = row(page, "#compare-left-tree", "src");
  await src.click();
  await expect(src).toHaveAttribute("aria-expanded", "false");
  await src.click();
  await expect(src).toHaveAttribute("aria-expanded", "true");
  await label(row(page, "#compare-left-tree", "limits.ts")).click();
  await expect.poll(async () => (await sent(page, "compareMessages", "sideOpen")).at(-1)?.id).toMatch(/limits\.ts$/);
  await label(row(page, "#compare-left-tree", "old-auth.ts")).click({ modifiers: ["Shift"] });
  expect(await selectedLabels(page, "#compare-left-tree")).toEqual(["limits.ts", "upload.ts", "new-client.ts", "old-auth.ts"]);
  await label(row(page, "#compare-left-tree", "upload.ts")).click({ modifiers: ["Control"] });
  expect(await selectedLabels(page, "#compare-left-tree")).toEqual(["limits.ts", "new-client.ts", "old-auth.ts"]);
  // The twisty closes the folder and the selection stays (on its hidden rows, so none is shown).
  await src.locator(".ftree-twisty").click();
  await expect(src).toHaveAttribute("aria-expanded", "false");
  await expect(src).not.toHaveClass(/selected/);
  await src.locator(".ftree-twisty").click();
  await label(row(page, "#compare-left-tree", "limits.ts")).click();
  await label(row(page, "#compare-left-tree", "upload.ts")).click({ modifiers: ["Control"] });
  await row(page, "#compare-left-tree", "upload.ts").click({ button: "right" });
  expect(await selectedLabels(page, "#compare-left-tree")).toEqual(["limits.ts", "upload.ts"]);
  await row(page, "#compare-left-tree", "logo.png").click({ button: "right" });
  expect(await selectedLabels(page, "#compare-left-tree")).toEqual(["logo.png"]);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("the filter: counts, Enter opens the first file, ↓ goes into the tree, Escape clears, Ctrl+F comes back", async ({ page }) => {
  await changes(page);
  const filter = page.locator("#file-filter");
  await filter.fill("home");
  await expect(page.locator("#file-filter-count")).toHaveText("1 of 14 files");
  await expect(page.locator("#file-tree .ftree-row .ftree-label")).toHaveText(["dist", "assets", /^HomeView/]);
  // A folder shown in part counts what it shows.
  await expect(row(page, "#file-tree", "assets").locator(".ftree-description")).toHaveText("1");
  await filter.press("Enter");
  await expect.poll(async () => (await sent(page, "changesMessages", "open")).at(-1)?.id).toBe("asset-5");
  await expect(page.locator("#file-tree")).toBeFocused();
  // A folder by its name: every file under it. While filtering, a selected folder is not sent (it would take hidden files).
  await page.keyboard.press("Control+f");
  await expect(filter).toBeFocused();
  await filter.fill("assets");
  await expect(page.locator("#file-filter-count")).toHaveText("12 of 14 files");
  await filter.press("ArrowDown");
  await expect(page.locator("#file-tree")).toBeFocused();
  await page.keyboard.press("Control+a");
  const ids = (await sent(page, "changesMessages", "selection")).at(-1).ids;
  expect(ids).toHaveLength(12);
  expect(ids).not.toContain("assets");
  await filter.fill("nothing-here");
  await expect(page.locator("#file-filter-empty")).toHaveText("No files match “nothing-here”.");
  await filter.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(page.locator("#file-filter-count")).toBeHidden();
  await expect(page.locator("#file-tree .ftree-row")).toHaveCount(16);
  // Compare's side says so too.
  await compare(page);
  await page.locator("#compare-left-filter").fill("nothing-here");
  await expect(page.locator("#compare-left-empty")).toHaveText("No files match “nothing-here”.");
  await page.locator("#compare-left-filter").fill("binary");
  await expect(page.locator("#compare-left-tree .ftree-row .ftree-label")).toHaveText(["src", "logo.png"]);
});

test("a search keeps its own open folders; clearing it gives the tree back as it was", async ({ page }) => {
  await changes(page);
  await row(page, "#file-tree", "assets").click();
  await expect(row(page, "#file-tree", "assets")).toHaveAttribute("aria-expanded", "false");
  await page.locator("#file-filter").fill("view");
  // The search opens what has matches, the tree's closed folder included.
  await expect(row(page, "#file-tree", "assets")).toHaveAttribute("aria-expanded", "true");
  await row(page, "#file-tree", "dist").click();
  await expect(row(page, "#file-tree", "dist")).toHaveAttribute("aria-expanded", "false");
  await page.locator("#file-filter").press("Escape");
  await expect(row(page, "#file-tree", "dist")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "#file-tree", "assets")).toHaveAttribute("aria-expanded", "false");
});

test("a long tree draws only the rows on screen, and the focused row is always one of them", async ({ page }) => {
  await changes(page, { state: "many", height: 700 });
  const tree = page.locator("#file-tree");
  const drawn = () => page.locator("#file-tree .ftree-row").count();
  expect(await drawn()).toBeLessThan(60);
  expect(Number(await page.locator("#file-tree .ftree-row").first().getAttribute("aria-setsize"))).toBe(3);
  await tree.focus();
  await page.keyboard.press("End");
  await expect(focusedLabel(page, "#file-tree")).toHaveText("logo.png");
  expect(await drawn()).toBeLessThan(60);
  // Seen whole, and named by aria-activedescendant.
  const inside = async () => {
    const t = await tree.boundingBox(), f = await page.locator("#file-tree .ftree-row.focused").boundingBox();
    return f.y >= t.y - 0.5 && f.y + f.height <= t.y + t.height + 0.5;
  };
  expect(await inside()).toBe(true);
  const active = await tree.getAttribute("aria-activedescendant");
  await expect(page.locator(`#${active}`)).toHaveClass(/focused/);
  await page.keyboard.press("Home");
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowDown");
  expect(await inside()).toBe(true);
  await expect(page.locator("#file-tree .ftree-row.focused")).toHaveAttribute("aria-posinset", "39");
  // Scrolled away, the focused row stays drawn (a screen reader still has it).
  await tree.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator("#file-tree .ftree-row", { hasText: "logo.png" })).toBeVisible();
  await expect(page.locator(`#${await tree.getAttribute("aria-activedescendant")}`)).toHaveCount(1);
  // Collapse All leaves the folders; Expand All brings every row back.
  await page.locator("#changes-tree-toggle").click();
  await expect(page.locator("#file-tree .ftree-row .ftree-label")).toHaveText(["dist", "README.md", "logo.png"]);
  await page.locator("#changes-tree-toggle").click();
  await expect.poll(() => tree.evaluate((el) => el.scrollHeight)).toBeGreaterThan(300 * 25);
});

test("a narrow tree: nothing spills out, the names stay longest, the letters line up", async ({ page }) => {
  for (const theme of ["dark", "hc-light"]) {
    const errors = await changes(page, { theme, width: 300 });
    const spill = await page.locator("#file-tree .ftree-row").evaluateAll((rows) => rows.filter((r) => r.scrollWidth > r.clientWidth + 1).map((r) => r.textContent));
    expect(spill, theme).toEqual([]);
    const renamed = page.locator("#file-tree .ftree-row", { has: page.locator(".ftree-old-path") }).first();
    const [name, old] = await Promise.all([label(renamed).boundingBox(), renamed.locator(".ftree-old-path").boundingBox()]);
    expect(name.width).toBeGreaterThan(old.width);
    const rights = await page.locator("#file-tree .ftree-row .file-status").evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().right)));
    expect(new Set(rights).size).toBe(1);
    expect(errors).toEqual([]);
  }
});

test("a page with the same key (the working tree refreshed) sends the selection again: the host dropped its own", async ({ page }) => {
  await page.addInitScript(() => window.addEventListener("message", (e) => { if (e.data?.type === "changes") window.__page = e.data; }));
  await changes(page);
  await label(row(page, "#file-tree", "AccountDialog")).click();
  await label(row(page, "#file-tree", "ActivityDetail")).click({ modifiers: ["Control"] });
  const before = (await sent(page, "changesMessages", "selection")).length;
  await page.evaluate(() => window.changePreview({ ...window.__page }));
  await expect.poll(async () => (await sent(page, "changesMessages", "selection")).length).toBe(before + 1);
  expect((await sent(page, "changesMessages", "selection")).at(-1).ids).toEqual(["asset-0", "asset-1"]);
});

test("a tree reset while hidden shows its first rows when it comes back", async ({ page }) => {
  await page.addInitScript(() => window.addEventListener("message", (e) => { if (e.data?.type === "changes") window.__page = e.data; }));
  await changes(page, { state: "many" });
  const tree = page.locator("#file-tree");
  await tree.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator("#file-tree .ftree-row", { hasText: "logo.png" })).toBeVisible();
  // Hidden (the Log's Changes pane can be), another commit arrives, then the tree is shown again.
  await tree.evaluate((el) => { el.style.display = "none"; });
  await page.evaluate(() => window.changePreview({ ...window.__page, key: "another" }));
  await tree.evaluate((el) => { el.style.display = ""; });
  await expect(row(page, "#file-tree", "dist")).toBeVisible();
  expect(await tree.evaluate((el) => el.scrollTop)).toBe(0);
});

test("pressing a row of an unfocused tree focuses that row, never the first one on the way", async ({ page }) => {
  await changes(page);
  const target = row(page, "#file-tree", "CategoryView");
  const box = await target.boundingBox();
  await page.mouse.move(box.x + 40, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.locator("#file-tree")).toBeFocused();
  await expect(page.locator("#file-tree .ftree-row.focused")).toHaveCount(0);
  await page.mouse.up();
  await expect(focusedLabel(page, "#file-tree")).toHaveText(/^CategoryView/);
});

test("Compare's commits while filtering: several selected all reach the host, Expand All reads only the shown ones", async ({ page }) => {
  await compare(page);
  await page.locator("#mode-commits").click();
  const commit = row(page, "#compare-left-tree", "fix: retry on 503");
  await expect(commit).toBeVisible();
  await page.locator("#compare-left-filter").fill("dana");
  await expect(page.locator("#compare-left-tree .ftree-row .ftree-label")).toHaveText(["fix: retry on 503"]);
  await page.locator("#compare-left-tree").focus();
  await page.keyboard.press("Control+a");
  await expect.poll(async () => (await sent(page, "compareMessages", "sideSelect")).at(-1)?.ids).toEqual([expect.stringMatching(/\/left\/commit$/)]);
  const all = (await sent(page, "compareMessages", "sideExpandAll")).length;
  await page.locator("#compare-left-tree-toggle").click();
  await expect.poll(async () => (await sent(page, "compareMessages", "sideExpand")).at(-1)?.id).toMatch(/\/left\/commit$/);
  expect((await sent(page, "compareMessages", "sideExpandAll")).length).toBe(all);
  // Nothing matches: it says commits.
  await page.locator("#compare-left-filter").fill("nothing-here");
  await expect(page.locator("#compare-left-empty")).toHaveText("No commits match “nothing-here”.");
});

const themeColor = (page, name) => page.evaluate((n) => {
  const probe = document.createElement("div");
  probe.style.color = `var(${n})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, name);

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`${theme}: selection, focus and hover look as VS Code's lists, the same in both views`, async ({ page }) => {
    const looks = [];
    for (const open of [changes, compare]) {
      const errors = await open(page, { theme });
      const tree = open === changes ? "#file-tree" : "#compare-left-tree";
      const rows = page.locator(`${tree} .ftree-row`);
      await rows.nth(2).click();
      const selected = rows.nth(2);
      const look = await selected.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, outline: getComputedStyle(el).outlineStyle }));
      // Focused and selected: the active selection, outlined; no frame around the tree.
      const want = await themeColor(page, "--vscode-list-activeSelectionForeground");
      if (!theme.startsWith("hc")) expect(look.color).toBe(want);
      expect(look.outline).toBe("solid");
      expect(await page.locator(tree).evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
      // Hover: the hover color; in high contrast a dashed outline.
      await rows.nth(4).hover();
      const hover = await rows.nth(4).evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, outline: getComputedStyle(el).outlineStyle }));
      if (theme.startsWith("hc")) expect(hover.outline).toBe("dashed");
      else expect(hover.bg).not.toBe("rgba(0, 0, 0, 0)");
      // The tree loses the focus: the selection turns inactive.
      await page.mouse.click(5, 5);
      const inactive = await selected.evaluate((el) => getComputedStyle(el).backgroundColor);
      looks.push({ ...look, hover: hover.bg, inactive });
      expect(errors).toEqual([]);
    }
    expect(looks[1]).toEqual(looks[0]);
  });
}
