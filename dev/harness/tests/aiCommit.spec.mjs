// The Commit side bar's ✨ (Generate Commit Message with AI) against the dev harness: a fake model
// streams the message into the box; it can be stopped, undone, and fails in words. REVIEW_SHOTS=1
// also saves each state in every theme under .playwright-mcp/review/G/ (gitignored).
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const REPLY = "feat(api): retry the upload once\n\nThe second try reuses the token, so a dropped connection no longer fails the release in acme-api and acme-web.";
const shots = fileURLToPath(new URL("../../../.playwright-mcp/review/G/", import.meta.url));

const open = async (page, { theme = "dark", ai = "on", state = "default", width = 300, height = 200, message = "", locale = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/commit${locale ? `.${locale}` : ""}.html?theme=${theme}&state=${state}&ai=${ai}&message=${encodeURIComponent(message)}`);
  await expect(page.locator("#commit-checked")).not.toBeEmpty();
  return errors;
};
const sent = (page) => page.evaluate(() => window.commitMessages.filter((m) => m.type === "generate" || m.type === "generateStop"));

test("✨ streams a message into the box; the buttons wait, then Undo brings the draft back", async ({ page }) => {
  const errors = await open(page, { message: "retry" });
  const button = page.locator("#commit-generate");
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-label", "Generate Commit Message with AI");
  await button.click();
  expect(await sent(page)).toEqual([{ type: "generate", text: "retry" }]);
  await expect(button).toHaveAttribute("aria-label", "Stop Generating");
  await expect(page.locator("#commit-message")).toHaveAttribute("readonly", "");
  await expect(page.locator("#commit-button")).toBeDisabled();
  await expect(page.locator("#commit-ai-text")).toHaveText("Writing a commit message…");
  await expect(page.locator("#commit-message")).toHaveValue(REPLY);
  await expect(button).toHaveAttribute("aria-label", "Generate Commit Message with AI");
  await expect(page.locator("#commit-message")).not.toHaveAttribute("readonly", "");
  await expect(page.locator("#commit-button")).toBeEnabled();
  await expect(page.locator("#commit-ai-text")).toHaveText("Written by AI: read it before you commit.");
  // Kept as the draft, as typing would.
  await expect.poll(() => page.evaluate(() => window.commitMessages.filter((m) => m.type === "draft").at(-1)?.text)).toBe(REPLY);
  await page.locator("#commit-ai-undo").click();
  await expect(page.locator("#commit-message")).toHaveValue("retry");
  await expect(page.locator("#commit-ai-status")).toBeHidden();
  expect(errors).toEqual([]);
});

test("the box's own Ctrl+Z takes the whole message back in one step", async ({ page }) => {
  await open(page, { message: "wip" });
  await page.locator("#commit-generate").click();
  await expect(page.locator("#commit-message")).toHaveValue(REPLY);
  await page.locator("#commit-message").press("Control+z");
  await expect(page.locator("#commit-message")).toHaveValue("wip");
});

test("typing after it wrote hides its line; Commit takes the message", async ({ page }) => {
  await open(page);
  await page.locator("#commit-generate").click();
  await expect(page.locator("#commit-message")).toHaveValue(REPLY);
  await page.locator("#commit-message").press("End");
  await page.locator("#commit-message").type(" Done.");
  await expect(page.locator("#commit-ai-status")).toBeHidden();
  await page.locator("#commit-button").click();
  const commit = await page.evaluate(() => window.commitMessages.find((m) => m.type === "commit"));
  expect(commit.message).toBe(`${REPLY} Done.`);
});

test("✨ again, or Esc, stops it and the box goes back as it was", async ({ page }) => {
  await open(page, { ai: "slow", message: "keep me" });
  const button = page.locator("#commit-generate");
  await button.click();
  await expect(page.locator("#commit-message")).not.toHaveValue("keep me");
  await button.click();
  await expect(page.locator("#commit-message")).toHaveValue("keep me");
  await expect(page.locator("#commit-ai-status")).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute("aria-label", "Stop Generating");
  await page.locator("#commit-message").press("Escape");
  await expect(page.locator("#commit-message")).toHaveValue("keep me");
  expect((await sent(page)).map((m) => m.type)).toEqual(["generate", "generateStop", "generate", "generateStop"]);
});

test("an error is said under the box, which keeps its text", async ({ page }) => {
  await open(page, { ai: "error", message: "mine" });
  await page.locator("#commit-generate").click();
  await expect(page.locator("#commit-validation")).toHaveText(/API key was not accepted/);
  await expect(page.locator("#commit-message")).toHaveValue("mine");
  await expect(page.locator("#commit-generate")).toBeEnabled();
});

test("no AI in the build: no ✨; nothing checked: ✨ waits", async ({ page }) => {
  await open(page, { ai: "off" });
  await expect(page.locator("#commit-generate")).toBeHidden();
  await open(page, { state: "none" });
  await expect(page.locator("#commit-generate")).toBeVisible();
  await expect(page.locator("#commit-generate")).toBeDisabled();
});

test("narrow view: ✨ stays on screen beside the other tools", async ({ page }) => {
  await open(page, { width: 200, height: 160 });
  const box = await page.locator("#commit-generate").boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`✨ in ${theme}: idle, writing and written, without console errors`, async ({ page }) => {
    const errors = await open(page, { theme, ai: "slow", height: 220 });
    const save = async (state) => {
      if (process.env.REVIEW_SHOTS !== "1") return;
      mkdirSync(shots, { recursive: true });
      await page.screenshot({ path: `${shots}commit-ai-${theme}-${state}.png` });
    };
    await page.locator("#commit-generate").hover();
    await save("idle");
    await page.locator("#commit-generate").click();
    await expect(page.locator("#commit-message")).not.toHaveValue("");
    await save("writing");
    await expect(page.locator("#commit-ai-text")).toHaveText("Written by AI: read it before you commit.", { timeout: 15_000 });
    await page.locator("#commit-ai-undo").focus();
    await save("written");
    expect(errors).toEqual([]);
  });
}

test("中文: ✨ and its line are translated", async ({ page }) => {
  await open(page, { locale: "zh-cn" });
  await expect(page.locator("#commit-generate")).toHaveAttribute("aria-label", "用 AI 生成提交说明");
  await page.locator("#commit-generate").click();
  await expect(page.locator("#commit-ai-text")).toHaveText("由 AI 撰写：提交前请先检查。");
  await expect(page.locator("#commit-ai-undo")).toHaveText("撤销");
  if (process.env.REVIEW_SHOTS === "1") {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: `${shots}commit-ai-dark-written.zh-cn.png` });
  }
});
