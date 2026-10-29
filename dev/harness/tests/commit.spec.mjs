// The Commit side bar's message box against the dev harness (the tree of changes above it is a
// native VS Code tree): Amend, the message and its two buttons, in a short view and every theme.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 300, height = 180, state = "default", query = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/commit.html?theme=${theme}&state=${state}${query}`);
  await expect(page.locator("#commit-checked")).not.toBeEmpty();
  return errors;
};
const sent = (page) => page.evaluate(() => window.commitMessages.filter((m) => m.type !== "draft"));

test("says what the Commit button takes", async ({ page }) => {
  await open(page);
  await expect(page.locator("#commit-checked")).toHaveText("8 files checked in 3 repositories");
  await expect(page.locator("#commit-button")).toBeEnabled();
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
    { type: "commit", message: "feat: one message for three repositories", amend: false, push: false, signOff: false },
    { type: "commit", message: "feat: and push it", amend: false, push: true, signOff: false },
  ]);
});

test("Amend with an empty box brings the last commit's message to edit", async ({ page }) => {
  await open(page);
  await page.locator("#commit-amend").click();
  await expect(page.locator("#commit-amend")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#commit-message")).toHaveValue("fix(web): keep the login callback on preview builds");
});

test("Sign-off goes with the commit; Author… shows who until cleared; History and Ctrl+M bring a message back", async ({ page }) => {
  await open(page);
  await page.locator("#commit-signoff").click();
  await expect(page.locator("#commit-signoff")).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#commit-author-line")).toBeHidden();
  await page.locator("#commit-author").click();
  await expect(page.locator("#commit-author-edit")).toHaveText("Author: rin <rin@example.com>");
  await page.locator("#commit-author-clear").click();
  await expect(page.locator("#commit-author-line")).toBeHidden();
  await page.locator("#commit-history").click();
  await expect(page.locator("#commit-message")).toHaveValue("fix(api): retry the upload once\n\nThe second try reuses the token.");
  await page.locator("#commit-message").fill("");
  await page.locator("#commit-message").press("Control+m");
  await expect(page.locator("#commit-message")).toHaveValue(/^fix\(api\): retry the upload once/);
  await page.locator("#commit-button").click();
  const commit = (await sent(page)).filter((m) => m.type === "commit").at(-1);
  expect(commit.signOff).toBe(true);
});

test("no files checked: both buttons wait", async ({ page }) => {
  await open(page, { state: "none" });
  await expect(page.locator("#commit-button")).toBeDisabled();
  await expect(page.locator("#commit-push-button")).toBeDisabled();
  await expect(page.locator("#commit-checked")).toHaveText("No files checked");
});

test("fills a narrow, short view: the buttons stay on screen and nothing is cut at the edges", async ({ page }) => {
  await open(page, { width: 220, height: 150 });
  for (const id of ["#commit-message", "#commit-button", "#commit-push-button", "#commit-history", "#commit-signoff"]) {
    const box = await page.locator(id).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(220);
    expect(box.y + box.height).toBeLessThanOrEqual(150);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("VS Code's default webview padding cannot push the box off the view", async ({ page }) => {
  await open(page);
  // VS Code's webview stylesheet gives the body 20px side padding.
  await page.addStyleTag({ content: "body { padding: 0 20px; }" });
  const button = await page.locator("#commit-button").boundingBox();
  const message = await page.locator("#commit-message").boundingBox();
  expect(message.x).toBeLessThan(20);
  expect(button.x).toBeLessThan(20);
  expect(message.x + message.width).toBeLessThanOrEqual(300);
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`renders in ${theme} without console errors`, async ({ page }) => {
    const errors = await open(page, { theme });
    await page.locator("#commit-amend").click();
    await expect(page.locator(".check svg")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("the message's checks show as it is typed, and never stop a commit", async ({ page }) => {
  const errors = await open(page, { height: 320 });
  const message = page.locator("#commit-message"), hints = page.locator("#commit-hints");
  await message.fill("fix: guard nil response\n\nThe uploader retried forever.");
  await expect(hints).toBeHidden();
  await message.fill(`feat: ${"x".repeat(74)}\nno blank line`);
  await expect(hints.locator("li")).toHaveText(["The subject is 80 characters: keep it to 72.", "Leave the second line empty: it separates the subject from the body."]);
  await page.locator("#commit-button").click();
  await expect.poll(() => sent(page).then((m) => m.some((x) => x.type === "commit"))).toBe(true);
  await expect(hints).toBeHidden();
  expect(errors).toEqual([]);
});

test("commit.template fills an empty box; its # guidance shows under it until the text is changed", async ({ page }) => {
  await open(page, { query: "&template=on", height: 320 });
  const message = page.locator("#commit-message"), guidance = page.locator("#commit-guidance");
  await expect(message).toHaveValue("feat: \n\nRefs: ACME-");
  await expect(guidance).toHaveText("Why is this change needed?\nWhat does it do?");
  await expect(page.locator("#commit-hints li")).toContainText(["Still the template's text: fill it in before committing."]);
  await message.fill("feat: keyboard shortcuts\n\nRefs: ACME-7");
  await expect(guidance).toBeHidden();
  await expect(page.locator("#commit-hints")).toBeHidden();
  await message.fill("");
  await expect(guidance).toBeVisible();
});

test("a typed draft is kept over the template", async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 180 });
  await page.goto("/commit.html?theme=dark&template=on&message=fix%3A%20mine");
  await expect(page.locator("#commit-message")).toHaveValue("fix: mine");
});
