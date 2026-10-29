// The Commit side bar against the dev harness: the JetBrains Commit window's checkbox tree, the
// message box and its two buttons, in a narrow side bar and in every theme.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 340, height = 640, state = "default" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/commit.html?theme=${theme}&state=${state}`);
  await expect(page.locator("#commit-tree .tree-row").first()).toBeVisible();
  return errors;
};
const row = (page, id) => page.locator(`[data-node="${encodeURIComponent(id)}"]`);
const sent = (page) => page.evaluate(() => window.commitMessages.filter((m) => m.type !== "selection" && m.type !== "draft"));

test("Changes and Unversioned Files by repository; tracked files checked, new files not", async ({ page }) => {
  await open(page);
  await expect(row(page, "changes")).toHaveAttribute("aria-checked", "true");
  await expect(row(page, "unversioned")).toHaveAttribute("aria-checked", "false");
  await expect(row(page, "changes:/work/acme-api:f:upload/handler.go")).toContainText("← upload/handle.go");
  await expect(page.locator("#commit-checked")).toHaveText("8 files checked in 3 repositories");
});

test("a checkbox checks everything under its row; Space checks the selected rows", async ({ page }) => {
  await open(page);
  await row(page, "changes:/work/acme-web").locator("[data-check]").click();
  await expect(row(page, "changes:/work/acme-web")).toHaveAttribute("aria-checked", "false");
  await expect(row(page, "changes")).toHaveAttribute("aria-checked", "mixed");
  await row(page, "unversioned:/work/acme-web:f:src/new.ts").locator(".row-label").click();
  await page.keyboard.press("Space");
  await expect(row(page, "unversioned:/work/acme-web:f:src/new.ts")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#commit-checked")).toHaveText("4 files checked in 3 repositories");
});

test("Commit needs a message; Ctrl+Enter commits, Commit and Push… pushes, and the box empties", async ({ page }) => {
  await open(page);
  await page.locator("#commit-button").click();
  await expect(page.locator("#commit-validation")).toBeVisible();
  await expect(page.locator("#commit-message")).toBeFocused();
  await page.locator("#commit-message").fill("feat: one message for three repositories");
  await expect(page.locator("#commit-validation")).toBeHidden();
  await page.locator("#commit-message").press("Control+Enter");
  await expect(page.locator("#commit-button")).toHaveText("Committing…");
  await expect(page.locator("#commit-message")).toHaveValue("");
  await page.locator("#commit-message").fill("feat: and push it");
  await page.locator("#commit-push-button").click();
  const commits = (await sent(page)).filter((m) => m.type === "commit");
  expect(commits).toEqual([
    { type: "commit", message: "feat: one message for three repositories", amend: false, push: false },
    { type: "commit", message: "feat: and push it", amend: false, push: true },
  ]);
});

test("Amend with an empty box brings the last commit's message to edit", async ({ page }) => {
  await open(page);
  await page.locator("#commit-amend").click();
  await expect(page.locator("#commit-amend")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#commit-message")).toHaveValue("fix(web): keep the login callback on preview builds");
});

test("no files checked: both buttons wait", async ({ page }) => {
  await open(page);
  for (const id of ["changes", "unversioned"]) {
    const box = row(page, id);
    if ((await box.getAttribute("aria-checked")) !== "false") await box.locator("[data-check]").click();
    await expect(box).toHaveAttribute("aria-checked", "false");
  }
  await expect(page.locator("#commit-button")).toBeDisabled();
  await expect(page.locator("#commit-push-button")).toBeDisabled();
  await expect(page.locator("#commit-checked")).toHaveText("No files checked");
});

test("a narrow, short side bar keeps the message and buttons on screen, and nothing scrolls sideways", async ({ page }) => {
  await open(page, { width: 240, height: 360, state: "many" });
  for (const id of ["#commit-message", "#commit-button", "#commit-push-button"]) {
    const box = await page.locator(id).boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(360);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator("#commit-tree").evaluate((el) => el.clientHeight)).toBeGreaterThan(60);
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`renders in ${theme} without console errors`, async ({ page }) => {
    const errors = await open(page, { theme });
    await expect(page.locator(".check svg").first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}
