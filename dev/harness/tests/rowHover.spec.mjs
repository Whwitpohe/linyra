// What a Log row does under the pointer, against the harness's mock rows (dev/harness/mock/hover.ts:
// row 0 is acme-web's HEAD on develop, with origin/develop and a tag; row 6 is master with its
// remotes and tags): the pointer cursor, the commit's disc growing, the buttons at the row's end
// (rowActions.ts), and each part of a branch pill as its own target (refPills.ts).
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 1500, height = 560, reduce = false } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.emulateMedia({ reducedMotion: reduce ? "reduce" : "no-preference" });
  await page.setViewportSize({ width, height });
  await page.goto(`/?theme=${theme}&state=default&avatars=off`);
  await expect(page.locator("#rows .row").first()).toBeVisible();
  return errors;
};
const row = (page, i) => page.locator(`#rows .row[data-index="${i}"]`);
const part = (page, i, ref) => row(page, i).locator(`.pill-part[data-ref="${ref}"]`);
const pointAt = async (page, locator) => {
  const b = await locator.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
};
const alpha = (color) => Number(/\/\s*([\d.]+)\)$/.exec(color)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)$/.exec(color)?.[1] ?? 1);

test("the row under the pointer: a pointer cursor, its commit's disc grown, no other row's", async ({ page }) => {
  const errors = await open(page);
  await pointAt(page, row(page, 3).locator(".subject"));
  await expect(row(page, 3)).toHaveCSS("cursor", "pointer");
  await expect(row(page, 3).locator(".graph-point")).toHaveCSS("transform", "matrix(1.25, 0, 0, 1.25, 0, 0)");
  await expect(row(page, 4).locator(".graph-point")).toHaveCSS("transform", "none");
  // It grows from its own centre: the disc's middle stays where the rails meet it.
  const before = await row(page, 4).locator(".graph-point").boundingBox();
  await pointAt(page, row(page, 4).locator(".subject"));
  await expect(row(page, 4).locator(".graph-point")).toHaveCSS("transform", "matrix(1.25, 0, 0, 1.25, 0, 0)");
  const after = await row(page, 4).locator(".graph-point").boundingBox();
  expect(Math.abs(after.x + after.width / 2 - (before.x + before.width / 2))).toBeLessThan(0.5);
  expect(Math.abs(after.y + after.height / 2 - (before.y + before.height / 2))).toBeLessThan(0.5);
  expect(after.width).toBeGreaterThan(before.width * 1.2);
  await expect(row(page, 3).locator(".graph-point")).toHaveCSS("transform", "none");
  expect(errors).toEqual([]);
});

test("reduced motion: the disc still grows, without the transition", async ({ page }) => {
  await open(page, { reduce: true });
  await expect(row(page, 0).locator(".graph-point")).toHaveCSS("transition-duration", "0s");
  await open(page);
  await expect(row(page, 0).locator(".graph-point")).toHaveCSS("transition-duration", "0.12s");
});

test("the checked-out commit's row offers Undo Commit and Edit Commit Message; every row offers ⋯", async ({ page }) => {
  await open(page);
  await expect(page.locator("#rows .row-actions")).toHaveCount(0);
  await pointAt(page, row(page, 0).locator(".subject"));
  const head = row(page, 0).locator(".row-actions .row-action");
  await expect(head).toHaveCount(3);
  expect(await head.evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")))).toEqual(["Undo Commit…", "Edit Commit Message…", "More Actions…"]);
  await pointAt(page, row(page, 3).locator(".subject"));
  await expect(row(page, 3).locator(".row-action")).toHaveCount(1);
  await expect(row(page, 3).locator(".row-action")).toHaveAttribute("aria-label", "More Actions…");
  // One toolbar, moved: the row left behind has none, and leaving the list hides it.
  await expect(page.locator("#rows .row-actions")).toHaveCount(1);
  await expect(row(page, 0).locator(".row-actions")).toHaveCount(0);
  await page.mouse.move(5, 5);
  await expect(page.locator("#rows .row-actions")).toBeHidden();
});

test("the buttons sit over the row's end on its own background, opaque, in every state", async ({ page }) => {
  await open(page);
  await pointAt(page, row(page, 0).locator(".subject"));
  const bar = row(page, 0).locator(".row-actions");
  const [rowBox, barBox] = [await row(page, 0).boundingBox(), await bar.boundingBox()];
  expect(Math.abs(barBox.x + barBox.width - (rowBox.x + rowBox.width))).toBeLessThan(1);
  expect(barBox.height).toBeCloseTo(rowBox.height, 0);
  const look = () => bar.evaluate((el) => ({ image: getComputedStyle(el).backgroundImage, color: getComputedStyle(el).backgroundColor }));
  const hovered = await look();
  expect(hovered.image).toContain("gradient");
  expect(alpha(hovered.color)).toBe(1);
  // Selected and focused: the fill follows the row's selection color.
  await row(page, 0).locator(".subject").click();
  await expect(row(page, 0)).toHaveAttribute("aria-selected", "true");
  expect((await look()).image).not.toBe(hovered.image);
});

test("Undo Commit asks the host for that commit's command; the row is selected too", async ({ page }) => {
  await open(page);
  await pointAt(page, row(page, 0).locator(".subject"));
  await row(page, 0).locator('[data-row-action="undo"]').click();
  const sent = await page.evaluate(() => window.harnessMessages.filter((m) => m.type === "rowAction"));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ action: "undo", repoId: "/work/acme-web" });
  expect(sent[0].sha).toMatch(/^[0-9a-f]{40}$/);
  await expect(row(page, 0)).toHaveAttribute("aria-selected", "true");
  await row(page, 0).locator('[data-row-action="reword"]').click();
  expect((await page.evaluate(() => window.harnessMessages.filter((m) => m.type === "rowAction"))).map((m) => m.action)).toEqual(["undo", "reword"]);
});

test("⋯ opens the row's own menu: a contextmenu event under the button, carrying the row's context", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.menus = [];
    // What VS Code's webview host does: the context of the target and its ancestors, inner first.
    window.addEventListener("contextmenu", (e) => {
      let context = {};
      for (let el = e.target.closest("[data-vscode-context]"); el; el = el.parentElement?.closest("[data-vscode-context]")) context = { ...JSON.parse(el.dataset.vscodeContext), ...context };
      window.menus.push({ x: e.clientX, y: e.clientY, context, prevented: e.defaultPrevented });
    });
  });
  await pointAt(page, row(page, 3).locator(".subject"));
  const more = row(page, 3).locator('[data-row-action="more"]');
  await more.click();
  const menus = await page.evaluate(() => window.menus);
  expect(menus).toHaveLength(1);
  expect(menus[0].context).toMatchObject({ webviewSection: "commit", head: false, preventDefaultContextMenuItems: true });
  expect(menus[0].prevented).toBe(false);
  const box = await more.boundingBox();
  expect(Math.abs(menus[0].y - (box.y + box.height))).toBeLessThan(1);
  await expect(row(page, 3)).toHaveAttribute("aria-selected", "true");
});

test("a pill's parts: the one under the pointer deepens alone and says what it is", async ({ page }) => {
  await open(page);
  const local = part(page, 6, "refs/heads/master"), remote = part(page, 6, "refs/remotes/origin/master");
  const tint = async () => [alpha(await local.evaluate((el) => getComputedStyle(el).backgroundColor)), alpha(await remote.evaluate((el) => getComputedStyle(el).backgroundColor))];
  const [l0, r0] = await tint();
  await pointAt(page, remote);
  await expect.poll(async () => (await tint())[1]).toBeGreaterThan(r0 + 0.15);
  expect((await tint())[0]).toBe(l0);
  await expect(remote).toHaveCSS("cursor", "pointer");
  await expect(remote).toHaveAttribute("title", "Remote branch origin/master\nClick for its details, right-click for its actions.");
  await expect(local).toHaveAttribute("title", "Branch master\nClick for its details, right-click for its actions.");
  await expect(part(page, 0, "refs/heads/develop")).toHaveAttribute("title", "Branch develop, checked out\nClick for its details, right-click for its actions.");
  // Its own menu: the remote part's right-click is the remote branch's.
  expect(JSON.parse(await remote.getAttribute("data-vscode-context"))).toEqual({ preventDefaultContextMenuItems: true, webviewSection: "refPill", repoId: "/work/acme-web", ref: "refs/remotes/origin/master", kind: "remote", current: false });
  // Color only: nothing moves.
  const before = await row(page, 6).locator(".row-refs .pill").evaluateAll((ps) => ps.map((p) => p.getBoundingClientRect().width));
  await pointAt(page, local);
  expect(await row(page, 6).locator(".row-refs .pill").evaluateAll((ps) => ps.map((p) => p.getBoundingClientRect().width))).toEqual(before);
});

test("a click on a part shows that branch, and marks that part alone while its sheet is open", async ({ page }) => {
  await open(page, { height: 760 });
  const remote = part(page, 0, "refs/remotes/origin/develop");
  await remote.click();
  await expect(page.locator("#branch-sheet")).toBeVisible();
  await expect(page.locator("#branch-sheet .sheet-name")).toContainText("origin/develop");
  await expect(remote).toHaveAttribute("aria-current", "true");
  await expect(part(page, 0, "refs/heads/develop")).not.toHaveAttribute("aria-current", "true");
  await page.mouse.move(5, 5);
  const marked = await remote.evaluate((el) => ({ outline: getComputedStyle(el).outlineStyle, tint: getComputedStyle(el).backgroundColor }));
  expect(marked.outline).toBe("solid");
  expect(alpha(marked.tint)).toBeGreaterThan(0.3);
});

for (const theme of ["light", "hc-dark", "hc-light"]) {
  test(`${theme}: a hovered part and the row's buttons read without tints where the theme has none`, async ({ page }) => {
    const errors = await open(page, { theme });
    const remote = part(page, 6, "refs/remotes/origin/master");
    await pointAt(page, remote);
    const look = await remote.evaluate((el) => ({ outline: getComputedStyle(el).outlineStyle, bg: getComputedStyle(el).backgroundColor }));
    if (theme === "light") {
      expect(alpha(look.bg)).toBeCloseTo(0.34, 2);
    } else {
      expect(look.outline).toBe("dashed");
      expect(alpha(look.bg)).toBe(0);
      const bar = await row(page, 6).locator(".row-actions").evaluate((el) => ({ image: getComputedStyle(el).backgroundImage, color: getComputedStyle(el).backgroundColor }));
      expect(bar.image).toBe("none");
      expect(alpha(bar.color)).toBe(1);
    }
    expect(errors).toEqual([]);
  });
}

test("zh-cn: the buttons and the parts' tooltips speak Chinese", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 560 });
  await page.goto("/index.zh-cn.html?theme=dark&state=default&avatars=off");
  await expect(page.locator("#rows .row").first()).toBeVisible();
  await pointAt(page, row(page, 0).locator(".subject"));
  expect(await row(page, 0).locator(".row-action").evaluateAll((bs) => bs.map((b) => b.title))).toEqual(["撤销提交…", "编辑提交信息…", "更多操作…"]);
  await expect(row(page, 0).locator(".row-actions")).toHaveAttribute("aria-label", "提交操作");
  await expect(part(page, 0, "refs/heads/develop")).toHaveAttribute("title", "分支 develop（已签出）\n单击查看详情，右键查看操作。");
  await expect(part(page, 0, "refs/remotes/origin/develop")).toHaveAttribute("title", "远程分支 origin/develop\n单击查看详情，右键查看操作。");
});

test("while the rows scroll under a still pointer they do not answer it; once they stop, the row under it does", async ({ page }) => {
  await open(page, { height: 400 });
  await pointAt(page, row(page, 2).locator(".subject"));
  await expect(page.locator("#rows .row-actions")).toBeVisible();
  const list = page.locator("#list");
  await list.evaluate((el) => { el.scrollTop += 60; });
  await expect(list).toHaveClass(/scrolling/);
  await expect(page.locator("#rows")).toHaveCSS("pointer-events", "none");
  // The wheel still scrolls the list while it does.
  const top = await list.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, 50);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(top);
  await expect(list).not.toHaveClass(/scrolling/, { timeout: 2000 });
  await page.mouse.move(400, 200);
  await pointAt(page, list);
  await expect(page.locator(".row:hover .row-actions")).toBeVisible();
  await expect(page.locator(".row:hover .graph-point")).toHaveCSS("transform", "matrix(1.25, 0, 0, 1.25, 0, 0)");
});
