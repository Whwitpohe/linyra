// The review form (Release…, Tag Across Repositories…) against the dev harness: everything on one
// page before anything runs, checked as it is typed, sent only when it is right. Every theme, and narrow.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", form = "release", width = 900, height = 760, query = "", locale = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/form${locale ? `.${locale}` : ""}.html?theme=${theme}&form=${form}${query}`);
  await expect(page.locator("#form-title")).not.toBeEmpty();
  return errors;
};
const sent = (page) => page.evaluate(() => window.formMessages.filter((m) => m.type !== "ready"));
const box = (page, label) => page.locator("vscode-checkbox", { hasText: label });

test("Release: the repositories, the tag, push and the notes on one page; Release sends exactly that", async ({ page }) => {
  await open(page);
  await expect(page.locator("#form-title")).toHaveText("Release develop into main");
  await expect(page.locator("#form-intro")).toContainText("Nothing runs until you press Release");
  // The first field to fill has the focus.
  await expect(page.locator("#field-tag")).toBeFocused();
  // Each repository: what merges into what, how many commits, and what happens to its working tree.
  await expect(box(page, "acme-web")).toContainText("develop → main · 4 commits");
  await expect(page.locator(".item-detail").first()).toHaveText("checked out: git merge");
  // One it cannot merge into: named with why, not offered.
  await expect(page.locator(".not-offered")).toContainText("acme-libs");
  await expect(page.locator(".not-offered")).toContainText("would conflict");
  await expect(page.locator("[data-field=push] .field-hint")).toContainText("stays local in: acme-api");
  // The notes are there to read, folded.
  await page.locator(".field-preview summary").click();
  await expect(page.locator(".preview")).toContainText("feat(web): sign in with a passkey");
  // The tag is checked as it is typed.
  const tag = page.locator("#field-tag");
  await tag.fill("v1 .4");
  await expect(page.locator("#field-tag-error")).toContainText("Not a valid name");
  await page.locator("#form-submit").click();
  expect(await sent(page)).toEqual([]);
  await tag.fill("v1.4.0");
  await expect(page.locator("#field-tag-error")).toBeHidden();
  // Untick acme-api, keep the push: Release sends just that.
  await box(page, "acme-api").click();
  await page.locator("#form-submit").click();
  await expect.poll(() => sent(page)).toEqual([{ type: "submit", values: { repos: ["acme-web"], tag: "v1.4.0", push: true } }]);
  await expect(page.locator("#form-submit")).toBeDisabled();
});

test("Release: nothing ticked is refused on the page; the host's own refusal shows under its field", async ({ page }) => {
  await open(page, { query: "&refuse=tag" });
  await box(page, "acme-web").click();
  await box(page, "acme-api").click();
  await page.locator("#form-submit").click();
  await expect(page.locator("#field-repos-error")).toHaveText("Tick at least one repository.");
  expect(await sent(page)).toEqual([]);
  await box(page, "acme-web").click();
  await expect(page.locator("#field-repos-error")).toBeHidden();
  await page.locator("#field-tag").fill("v1.4.0");
  await page.locator("#form-submit").click();
  await expect(page.locator("#field-tag-error")).toHaveText("acme-web already has the tag v1.4.0.");
  await expect(page.locator("#form-submit")).toBeEnabled();
});

test("Tag Across Repositories: name, optional message, push, where; Escape cancels", async ({ page }) => {
  await open(page, { form: "tag" });
  await expect(page.locator("label[for=field-message]")).toHaveText("Message (optional)");
  await expect(page.getByText("lightweight")).toHaveCount(0);
  await page.locator("#form-submit").click();
  await expect(page.locator("#field-name-error")).toHaveText("Enter a name.");
  await page.locator("#field-name").fill("v1.4.0");
  await page.locator("#field-message").fill("First release");
  await box(page, "Push the tag").click();
  await page.locator("#field-message").press("Control+Enter");
  await expect.poll(() => sent(page)).toEqual([{ type: "submit", values: { name: "v1.4.0", message: "First release", push: false, repos: ["acme-web", "acme-api"] } }]);
  await open(page, { form: "tag" });
  await page.locator("#field-name").press("Escape");
  await expect.poll(() => sent(page)).toEqual([{ type: "cancel" }]);
});

test("in Chinese the page's own words are Chinese", async ({ page }) => {
  await open(page, { locale: "zh-cn" });
  await expect(page.locator("#form-title")).toHaveText("发版：把 develop 合入 main");
  await expect(page.locator("#form-submit")).toHaveText("发版");
  await expect(page.locator(".not-offered-title")).toHaveText("不可选");
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  test(`${theme}, 360 px: no sideways scroll, theme colors, a visible focus`, async ({ page }) => {
    const errors = await open(page, { theme, width: 360, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const submit = page.locator("#form-submit");
    expect(await submit.evaluate((b) => getComputedStyle(b).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    await submit.focus();
    expect(await submit.evaluate((b) => getComputedStyle(b).outlineStyle)).not.toBe("none");
    await page.screenshot({ path: `test-results/form-release-${theme}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
