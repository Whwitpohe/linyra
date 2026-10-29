// The Log's repository strip, the graph's author discs and fold box, the narrow layout (the Log's own
// width), the toggled toolbar look, and the commit details pane, as the 2026-10-29 design review
// settled them.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", state = "default", width = 1600, height = 520 } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/?theme=${theme}&state=${state}`);
  await expect(page.locator("#rows .row[data-index]").first()).toBeVisible();
  return errors;
};
/** A theme variable as the color the browser computes for it ("rgb(…)"). */
const themeColor = (page, name) => page.evaluate((n) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${n})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, name);

test("a run of one repository shares one 3px strip; the name is the row's text, untinted", async ({ page }) => {
  await open(page, { state: "graph" });
  const bands = page.locator("#rows .row[data-index] .repo-band");
  // The first three commits are acme-web's: one run, so only the first starts it and only the last ends it.
  await expect(bands.nth(0)).toHaveClass(/band-start/);
  await expect(bands.nth(0)).not.toHaveClass(/band-end/);
  await expect(bands.nth(1)).not.toHaveClass(/band-start|band-end/);
  await expect(bands.nth(2)).toHaveClass(/band-end/);
  // The strip is the band's background: 3px wide, starting 3px down where the run starts.
  const strip = (i) => bands.nth(i).evaluate((band) => {
    const s = getComputedStyle(band), label = band.querySelector(".repo-label");
    return { tint: s.backgroundColor, image: s.backgroundImage, size: s.backgroundSize, position: s.backgroundPosition,
      label: label ? getComputedStyle(label).color : null, labelBackground: label ? getComputedStyle(label).backgroundColor : null, row: getComputedStyle(band.closest(".row")).color };
  });
  const first = await strip(0);
  expect(first.tint).toBe("rgba(0, 0, 0, 0)");
  expect(first.image).toMatch(/^linear-gradient\(rgb/);
  expect(first.size).toBe("3px calc(100% - 3px)");
  expect(first.position).toBe("0px 3px");
  expect(first.labelBackground).toBe("rgba(0, 0, 0, 0)");
  expect(first.label).toBe(first.row);
  // The middle of the run reaches the row's edges: the strip is continuous.
  expect(await strip(1)).toMatchObject({ size: "3px 100%", position: "0px 0px" });
  expect(await strip(2)).toMatchObject({ size: "3px calc(100% - 3px)", position: "0px 0px" });
});

test("high contrast: neither the strip nor the name is framed", async ({ page }) => {
  await open(page, { theme: "hc-dark", state: "graph" });
  const band = page.locator("#rows .row[data-index] .repo-band").first();
  expect(await band.evaluate((el) => [getComputedStyle(el).outlineStyle, getComputedStyle(el.querySelector(".repo-label")).outlineStyle])).toEqual(["none", "none"]);
});

test("a commit is its author's disc, ringed in the lane's color; a merge keeps its hollow dot; my commits ring thicker", async ({ page }) => {
  await open(page, { state: "graph" });
  const rows = page.locator("#rows .row[data-index]");
  // Row 0 merges release-1.4: the small hollow dot, no disc.
  await expect(rows.nth(0).locator(".author-disc")).toHaveCount(0);
  await expect(rows.nth(0).locator(".graph-node.graph-merge")).toHaveCount(1);
  // Row 1 is rin's, row 2 dana's (the harness user).
  await expect(rows.nth(1).locator(".author-disc-initial")).toHaveText("R");
  await expect(rows.nth(1).locator(".author-disc")).not.toHaveClass(/mine/);
  await expect(rows.nth(2).locator(".author-disc-initial")).toHaveText("D");
  await expect(rows.nth(2).locator(".author-disc")).toHaveClass(/mine/);
  const widths = await rows.evaluateAll((els) => els.slice(1, 3).map((el) => parseFloat(getComputedStyle(el.querySelector(".author-disc-ring")).strokeWidth)));
  expect(widths[1]).toBeGreaterThan(widths[0]);
  // The ring takes the lane's color: the rail drawn into the node.
  const [ring, rail] = await rows.nth(1).evaluate((el) => {
    const disc = el.querySelector(".author-disc"), accent = [...disc.classList].find((c) => c.startsWith("accent-"));
    return [getComputedStyle(disc.querySelector(".author-disc-ring")).stroke, getComputedStyle(el.querySelector(`.graph-edge.${accent}`)).stroke];
  });
  expect(ring).toBe(rail);
});

test("the first lane's disc is not cut at the graph's edge, and a row stays a few SVG nodes", async ({ page }) => {
  await open(page, { state: "default" });
  const shapes = await page.locator("#rows .row[data-index]").evaluateAll((rows) => rows.map((row) => {
    const graph = row.querySelector(".commit-graph"), disc = row.querySelector(".author-disc-ring");
    const g = graph.getBoundingClientRect(), d = disc?.getBoundingClientRect();
    // Rails are one path per color, as before the discs: count the node (svg, its group and what is in it).
    return { nodes: graph.querySelectorAll(":scope > g *").length + 2, left: d ? d.left - g.left : null, top: d ? d.top - g.top : null, bottom: d ? g.bottom - d.bottom : null };
  }));
  for (const s of shapes) {
    expect(s.nodes).toBeLessThanOrEqual(6);
    if (s.left === null) continue;
    expect(s.left).toBeGreaterThanOrEqual(0);
    expect(s.top).toBeGreaterThanOrEqual(0);
    expect(s.bottom).toBeGreaterThanOrEqual(0);
  }
  expect(shapes.filter((s) => s.left !== null).length).toBeGreaterThan(5);
});

test("linear history shows its ⊟ only under the pointer, in the disc's place; a folded run's ⊞ always shows", async ({ page }) => {
  await open(page, { state: "default" });
  const control = page.locator("#rows [data-fold-collapse]").first();
  const look = () => control.evaluate((g) => ({ box: getComputedStyle(g.querySelector(".graph-fold-box")).opacity, disc: getComputedStyle(g.querySelector(".author-disc-ring")).opacity }));
  await page.mouse.move(5, 5);
  expect(await look()).toEqual({ box: "0", disc: "1" });
  await control.hover();
  expect(await look()).toEqual({ box: "1", disc: "0" });
  // Fold it: the run's ⊞ shows without the pointer on it.
  await control.click();
  await page.mouse.move(5, 5);
  const expand = page.locator("#rows .commit-graph [data-fold-expand]").first();
  await expect(expand).toBeVisible();
  expect(await expand.evaluate((g) => getComputedStyle(g.querySelector(".graph-fold-box")).opacity)).toBe("1");
});

test("a Log narrower than 720px keeps the strip only, though the window is wider", async ({ page }) => {
  // 1100px window: the Repo List and the changed files leave the Log well under 720px.
  await open(page, { width: 1100 });
  const log = await page.locator(".log").evaluate((el) => el.getBoundingClientRect().width);
  expect(log).toBeLessThan(720);
  const row = page.locator("#rows .row[data-index]").first();
  await expect(row.locator(".repo-label")).toBeHidden();
  await expect(row.locator(".author")).toBeHidden();
  await expect(page.locator("#rows .row .row-refs").first()).toBeHidden();
  expect(await row.locator(".repo-band").evaluate((el) => el.getBoundingClientRect().width)).toBe(3);
  // Hiding the changed files widens the Log past 720px: the names come back.
  await page.click("#toggle-changes");
  await expect(row.locator(".repo-label")).toBeVisible();
  await expect(row.locator(".author")).toBeVisible();
});

for (const theme of ["dark", "hc-dark"]) {
  test(`${theme}: a toggled toolbar button is filled${theme === "dark" ? " without a frame" : " and framed"}`, async ({ page }) => {
    await open(page, { theme });
    const look = await page.locator("#toggle-changes").evaluate((el) => ({ pressed: el.getAttribute("aria-pressed"), outline: getComputedStyle(el).outlineStyle, background: getComputedStyle(el).backgroundColor }));
    expect(look.pressed).toBe("true");
    if (theme === "dark") {
      expect(look.outline).toBe("none");
      expect(look.background).not.toBe("rgba(0, 0, 0, 0)");
    } else expect(look.outline).toBe("solid");
  });
}

test("the details header is a pane header: capitals, a codicon chevron, one line, and a click anywhere folds it", async ({ page }) => {
  await open(page, { state: "graph", height: 700 });
  const heading = page.locator("#detail-heading");
  await expect(heading).toBeVisible();
  await expect(heading.locator("svg.codicon.detail-chevron")).toHaveCount(1);
  expect(await heading.textContent()).not.toContain("▾");
  const look = await heading.evaluate((el) => ({ transform: getComputedStyle(el).textTransform, size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight, line: getComputedStyle(el).borderTopWidth }));
  expect(look).toEqual({ transform: "uppercase", size: "11px", weight: "700", line: "1px" });
  // The sash above draws no second line and no grab handle.
  const sash = await page.locator("#detail-splitter").evaluate((el) => ({ line: getComputedStyle(el).borderTopWidth, handle: getComputedStyle(el, "::before").content }));
  expect(sash).toEqual({ line: "0px", handle: "none" });
  await heading.locator(".detail-heading-label").click();
  await expect(page.locator("#commit-details")).toBeHidden();
  await expect(page.locator("#detail-toggle")).toHaveAttribute("aria-expanded", "false");
  await page.locator("#detail-toggle").click();
  await expect(page.locator("#commit-details")).toBeVisible();
});

test("the details: the UI font and the text color for the title, the editor's font for the body, pills for references", async ({ page }) => {
  await open(page, { state: "graph", height: 700 });
  const details = page.locator("#commit-details");
  const fonts = await details.evaluate((el) => ({
    title: getComputedStyle(el.querySelector(".commit-title")).fontFamily, body: getComputedStyle(el.querySelector(".commit-body")).fontFamily,
    ui: getComputedStyle(document.body).getPropertyValue("--vscode-font-family").trim(), mono: getComputedStyle(document.body).getPropertyValue("--vscode-editor-font-family").trim(),
    titleColor: getComputedStyle(el.querySelector(".commit-title")).color, weight: getComputedStyle(el.querySelector(".commit-title")).fontWeight,
    marker: el.querySelector(".repo-marker").getBoundingClientRect().width,
    dateWraps: getComputedStyle(el.querySelector(".commit-date")).whiteSpace, emailWraps: getComputedStyle(el.querySelector(".commit-email")).whiteSpace,
  }));
  const family = (f) => f.replace(/["'\s]/g, "");
  expect(family(fonts.title)).toBe(family(fonts.ui));
  expect(family(fonts.body)).toBe(family(fonts.mono));
  expect(fonts.titleColor).toBe(await themeColor(page, "--vscode-foreground"));
  expect(fonts.weight).toBe("600");
  expect(fonts.marker).toBe(8);
  expect([fonts.dateWraps, fonts.emailWraps]).toEqual(["nowrap", "nowrap"]);
  // main and origin/main point here: one pill, the branch and its remote.
  await expect(details.locator(".commit-refs .pill")).toHaveCount(1);
  await expect(details.locator(".commit-refs .pill .pill-label")).toHaveText(["main", "origin"]);
});

test("a parent hash in the details selects that commit in the Log", async ({ page }) => {
  await open(page, { state: "graph", height: 700 });
  const rows = page.locator("#rows .row[data-index]");
  await rows.nth(0).locator(".subject").click();
  const parents = page.locator("#commit-details .parent-sha");
  await expect(parents).toHaveCount(2);
  await parents.first().click();
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#commit-details .commit-title")).toHaveText(await rows.nth(1).locator(".subject").textContent());
});

test("a changed file's line counts take the add and delete colors", async ({ page }) => {
  await open(page);
  const stats = page.locator("#file-tree .tree-row .row-stats .line-counts").first();
  await expect(stats).toBeVisible();
  expect(await stats.locator(".count-added").evaluate((el) => getComputedStyle(el).color)).toBe(await themeColor(page, "--vscode-gitDecoration-addedResourceForeground"));
  expect(await stats.locator(".count-deleted").evaluate((el) => getComputedStyle(el).color)).toBe(await themeColor(page, "--vscode-gitDecoration-deletedResourceForeground"));
});

test("Automatic layout: the changed files sit beside the Log while it keeps 520px for its subjects; below that they go under it", async ({ page }) => {
  for (const [width, stacked] of [[1500, false], [1000, true], [800, true]]) {
    await open(page, { width, height: 700 });
    const workspace = page.locator(".workspace");
    if (stacked) await expect(workspace).toHaveClass(/\bstacked\b/);
    else await expect(workspace).not.toHaveClass(/\bstacked\b/);
    const log = await page.locator("#list").evaluate((el) => el.clientWidth);
    expect(log, `${width}px window`).toBeGreaterThanOrEqual(520);
    // The subjects are there to read, not squeezed out.
    expect(await page.locator("#rows .row .subject").first().evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(120);
  }
});

test("Automatic layout follows the panel: narrowed, the changed files move under the Log; widened, back beside it", async ({ page }) => {
  await open(page, { width: 1500, height: 700 });
  const workspace = page.locator(".workspace");
  await expect(workspace).not.toHaveClass(/\bstacked\b/);
  await page.setViewportSize({ width: 900, height: 700 });
  await expect(workspace).toHaveClass(/\bstacked\b/);
  await page.setViewportSize({ width: 1500, height: 700 });
  await expect(workspace).not.toHaveClass(/\bstacked\b/);
});
