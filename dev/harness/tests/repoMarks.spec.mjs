// The Repo List's marks (dev/harness/mock.ts mockMarks): each repository's branch, VS Code's * + !
// for uncommitted work, a branch the other ticked repositories are not on, and a merge stopped with
// conflicts, in a wide and a narrow Repo List and in high contrast.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 190, state = "default" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1400, height: 600 });
  await page.addInitScript((w) => sessionStorage.setItem("linyra-layout", JSON.stringify({ repoPaneWidth: w })), width);
  await page.goto(`/?theme=${theme}&state=${state}&avatars=off`);
  await expect(page.locator("#repo-rows .repo-branch").first()).toBeAttached();
  return errors;
};
const repoRow = (page, name) => page.locator("#repo-rows .repo-row").filter({ has: page.locator(`.repo-name[data-name="${name}"]`) });
const shown = (locator) => locator.evaluate((el) => getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0);
const contextOf = (locator) => locator.getAttribute("data-vscode-context").then((v) => JSON.parse(v));

test("a wide Repo List names every branch, its * + !, and a stopped merge with its conflicts", async ({ page }) => {
  const errors = await open(page, { width: 420 });
  const web = repoRow(page, "acme-web"), api = repoRow(page, "acme-api"), libs = repoRow(page, "acme-libs");
  await expect(web.locator(".repo-branch")).toHaveText("develop");
  await expect(web.locator(".repo-work")).toHaveText("*");
  await expect(api.locator(".repo-branch")).toHaveText("develop");
  await expect(api.locator(".repo-work")).toHaveCount(0);
  // acme-libs is on another branch (marked) and stopped in a merge with 2 conflicts.
  await expect(libs.locator(".repo-branch")).toHaveClass(/drift/);
  await expect(libs.locator(".repo-branch")).toHaveText("feature/login");
  // The badge keeps the icon and the count; the row under it says what stopped.
  await expect(libs.locator(".op-count")).toContainText("2");
  expect(await shown(libs.locator(".op-word"))).toBe(false);
  expect(await shown(libs.locator(".op-count"))).toBe(true);
  expect(await shown(libs.locator(".repo-work")), "the badge says it: no * + ! beside it").toBe(false);
  await expect(libs).toHaveAttribute("title", /On branch feature\/login\nMost of the ticked repositories are on develop\.\nUncommitted: modified \(\*\), staged \(\+\)\nMerge stopped: 2 files have conflicts \(!\)/);
  await expect(libs).toHaveAttribute("aria-label", /^acme-libs, On branch feature\/login, Most of the ticked repositories are on develop\. Uncommitted: modified, staged, Merge stopped: 2 files have conflicts\. /);
  expect(await contextOf(libs)).toMatchObject({ webviewSection: "repo", repoId: "/work/acme-libs", operation: "merge", conflicts: true });
  expect(await contextOf(web)).not.toHaveProperty("operation");
  expect(errors).toEqual([]);
});

test("a narrow Repo List keeps the names whole: only a differing branch, as an icon; a merge as its icon and count", async ({ page }) => {
  const errors = await open(page, { width: 190, state: "many" });
  const web = repoRow(page, "acme-web"), libs = repoRow(page, "acme-libs"), svc = repoRow(page, "acme-svc-01");
  expect(await shown(web.locator(".repo-branch")), "develop, like the rest: not named").toBe(false);
  await expect(web.locator(".repo-work")).toHaveText("*");
  expect(await shown(libs.locator(".op-word"))).toBe(false);
  expect(await shown(libs.locator(".op-count"))).toBe(true);
  expect(await shown(libs.locator(".op-noun")), "narrow: the count alone").toBe(false);
  expect(await shown(libs.locator(".repo-branch"))).toBe(false);
  // A detached HEAD differs from develop: its branch icon, the commit in the tooltip.
  const detached = page.locator("#repo-rows .repo-row:not(:has(.repo-op)) .repo-branch.drift").first();
  expect(await shown(detached.locator(".codicon"))).toBe(true);
  expect(await shown(detached.locator(".branch-text"))).toBe(false);
  for (const r of [web, svc]) {
    const name = r.locator(".repo-name");
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth), "the name fits").toBe(true);
  }
  expect(errors).toEqual([]);
});

for (const theme of ["light", "hc-dark", "hc-light"]) {
  test(`the marks have their colors in ${theme}`, async ({ page }) => {
    const errors = await open(page, { theme, width: 420 });
    const libs = repoRow(page, "acme-libs");
    const color = (l) => l.evaluate((el) => getComputedStyle(el).color);
    const description = await color(repoRow(page, "acme-api").locator(".repo-branch"));
    expect(await color(libs.locator(".repo-branch")), "a differing branch is not the description color").not.toBe(description);
    expect(await libs.locator(".repo-branch").evaluate((el) => getComputedStyle(el).fontWeight)).toBe("600");
    expect(await color(libs.locator(".repo-op"))).not.toBe(description);
    expect(errors).toEqual([]);
  });
}

test("a stopped merge has its own row under the repository: what stopped, Resolve… and Abort…, Enter for the next step", async ({ page }) => {
  const errors = await open(page, { width: 420 });
  const op = page.locator("#repo-rows .op-row");
  await expect(op).toHaveCount(1);
  await expect(op.locator(".op-text")).toHaveText("Merge stopped · 2 files conflict");
  await expect(op.locator(".op-action")).toHaveText(["Resolve…", "Abort…"]);
  // Right under acme-libs, a level below it.
  const order = await page.locator("#repo-rows .repo-row").evaluateAll((rows) => rows.map((r) => r.querySelector(".repo-name")?.dataset.name ?? (r.classList.contains("op-row") ? "op" : "")));
  expect(order[order.indexOf("acme-libs") + 1]).toBe("op");
  // Under the collapsed repository it is its neighbour (a collapsed item shows no children); opened, its child.
  await expect(op).toHaveAttribute("aria-level", "1");
  await page.locator("#repo-rows .repo-row", { has: page.locator('.repo-name[data-name="acme-libs"]') }).locator(".tree-twisty").click();
  await expect(op).toHaveAttribute("aria-level", "2");
  await expect(op).toHaveAttribute("aria-label", /Merge stopped · 2 files conflict\. Enter: Resolve Conflicts…/);
  expect(JSON.parse(await op.getAttribute("data-vscode-context"))).toMatchObject({ webviewSection: "repo", repoId: "/work/acme-libs", operation: "merge", conflicts: true });
  // Its buttons ask the host for the matching command; the list's cursor does not move for them.
  const asked = () => page.evaluate(() => window.harnessMessages.filter((m) => m.type === "operation"));
  await op.locator(".op-action", { hasText: "Abort…" }).click();
  await expect.poll(async () => (await asked()).at(-1)).toEqual({ type: "operation", action: "abort", repoId: "/work/acme-libs" });
  // A click on the row itself, or Space, only puts the cursor there: no step runs by accident.
  await op.locator(".op-text").click();
  await expect(op).toHaveClass(/active/);
  await page.keyboard.press(" ");
  await page.waitForTimeout(100);
  expect((await asked()).length).toBe(1);
  // From the keyboard: the row is a tree item; Enter is its next step.
  await page.locator("#repo-rows").focus();
  await page.keyboard.press("Home");
  const index = Number(await op.getAttribute("data-row"));
  for (let i = 0; i < index; i++) await page.keyboard.press("ArrowDown");
  await expect(op).toHaveClass(/active/);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await asked()).at(-1)).toEqual({ type: "operation", action: "resolve", repoId: "/work/acme-libs" });
  expect(errors).toEqual([]);
});

test("narrow: the stopped merge's buttons keep their icons, their words go to the tooltips", async ({ page }) => {
  await open(page, { width: 220 });
  const op = page.locator("#repo-rows .op-row");
  await expect(op).toBeVisible();
  expect(await shown(op.locator(".op-action-label").first())).toBe(false);
  expect(await shown(op.locator(".op-action .codicon").first())).toBe(true);
  await expect(op.locator(".op-action").first()).toHaveAttribute("title", "Resolve…");
  const box = await op.boundingBox(), pane = await page.locator("#repo-rows").boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 1);
});
