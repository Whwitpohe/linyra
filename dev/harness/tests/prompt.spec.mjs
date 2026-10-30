// Questions asked where the user acted (src/promptModel.ts, webview/ui/prompt.ts, promptHost.ts),
// against the harness, which asks as the host's Ask does (dev/harness/shim.ts: Update Project's
// ways, window.harnessAsk for any question, branch-name checks): under the button that was clicked
// in place of VS Code's picker at the top of the window; the keyboard, the pin, several choices,
// names checked as they are typed, the filter, and a right-click's place in the menu's context.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 1300, height = 640, locale = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/${locale ? `index.${locale}.html` : ""}?theme=${theme}&state=default&avatars=off`);
  await expect(page.locator("#rows .row").first()).toBeVisible();
  return errors;
};
const prompt = (page) => page.locator(".prompt");
const answers = (page) => page.evaluate(() => window.harnessMessages.filter((m) => m.type === "promptAnswer"));
/** Asks as the host does (a message, a moment later), and waits until the question is open. */
const ask = async (page, request, at) => {
  await page.evaluate(([r, a]) => window.harnessAsk(r, a), [request, at]);
  await expect(page.locator(".prompt")).toHaveAttribute("aria-label", request.title);
};
/** Clicks Update Project and waits until its question is open. */
const update = async (page) => {
  await page.locator("#toolbar-update").click();
  await expect(page.locator(".prompt")).toBeVisible();
};
const many = (n) => Array.from({ length: n }, (_, i) => ({ label: `acme-${["web", "api", "libs", "docs", "jobs", "mobile", "infra", "tools", "data", "auth", "mail", "search"][i]}`, description: `${i + 1} commits` }));

test("Update Project asks its way under its button: the button's message carries where it was", async ({ page }) => {
  const errors = await open(page);
  const button = page.locator("#toolbar-update");
  await button.click();
  await expect(prompt(page)).toBeVisible();
  const [b, p] = [await button.boundingBox(), await prompt(page).boundingBox()];
  // Right under it; near the right end, the popup's right edge lines up with the button's.
  expect(p.y).toBeGreaterThanOrEqual(b.y + b.height);
  expect(p.y).toBeLessThan(b.y + b.height + 6);
  expect(Math.abs(p.x + p.width - (b.x + b.width)) < 1.5 || Math.abs(p.x - b.x) < 1.5).toBe(true);
  await expect(prompt(page).locator(".prompt-title")).toHaveText(/^Update 3 repositories: how\?/);
  await expect(prompt(page).locator(".prompt-item")).toHaveCount(3);
  await expect(prompt(page).locator(".prompt-item").first()).toHaveClass(/active/);
  const sent = await page.evaluate(() => window.harnessMessages.find((m) => m.type === "toolbarAction" && m.action === "updateProject"));
  expect(sent.at).toEqual({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) });
  // ↓ Enter answers the second; the focus goes back to the button.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(prompt(page)).toHaveCount(0);
  expect((await answers(page)).at(-1)).toMatchObject({ answer: { index: 1 } });
  await expect(button).toBeFocused();
  expect(errors).toEqual([]);
});

test("a click answers; the pin answers with it; Esc and a click outside cancel", async ({ page }) => {
  await open(page);
  await update(page);
  await prompt(page).locator(".prompt-item").nth(2).click();
  expect((await answers(page)).at(-1).answer).toEqual({ index: 2 });
  await update(page);
  const row = prompt(page).locator(".prompt-item").nth(1);
  await row.hover();
  await expect(row.locator(".prompt-pin")).toHaveCSS("opacity", "1");
  await row.locator(".prompt-pin").click();
  expect((await answers(page)).at(-1).answer).toEqual({ index: 1, pin: true });
  await update(page);
  await page.keyboard.press("Escape");
  await expect(prompt(page)).toHaveCount(0);
  expect((await answers(page)).at(-1).answer).toBeUndefined();
  await update(page);
  await page.mouse.click(400, 400);
  await expect(prompt(page)).toHaveCount(0);
  await expect.poll(async () => (await answers(page)).length).toBe(4);
  expect((await answers(page)).at(-1).answer).toBeUndefined();
});

test("a shortcut's question opens under the button it names; one near the bottom opens above its place", async ({ page }) => {
  await open(page);
  await ask(page, { kind: "pick", title: "Remote to push to", items: [{ label: "origin" }, { label: "upstream" }] }, "toolbar-push");
  const [b, p] = [await page.locator("#toolbar-push").boundingBox(), await prompt(page).boundingBox()];
  expect(p.y).toBeGreaterThanOrEqual(b.y + b.height);
  await page.keyboard.press("Escape");
  await ask(page, { kind: "pick", title: "Remote to push to", items: [{ label: "origin" }, { label: "upstream" }] }, { x: 300, y: 620, w: 0, h: 0 });
  const above = await prompt(page).boundingBox();
  expect(above.y + above.height).toBeLessThanOrEqual(620);
  await expect(prompt(page)).toHaveClass(/above/);
});

test("several choices: ticked ones start ticked, Space ticks, OK or Enter gives them", async ({ page }) => {
  await open(page);
  await ask(page, { kind: "pickMany", title: "Push to 3 repositories", items: [{ label: "acme-web", picked: true }, { label: "acme-api", detail: "Tick to force push" }, { label: "acme-libs", picked: true }] }, "toolbar-push");
  const items = prompt(page).locator(".prompt-item");
  await expect(prompt(page).locator(".prompt-list")).toHaveAttribute("aria-multiselectable", "true");
  expect(await items.evaluateAll((els) => els.map((e) => e.getAttribute("aria-selected")))).toEqual(["true", "false", "true"]);
  await expect(items.nth(1).locator(".prompt-detail")).toHaveText("Tick to force push");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await items.nth(2).click();
  expect(await items.evaluateAll((els) => els.map((e) => e.getAttribute("aria-selected")))).toEqual(["true", "true", "false"]);
  await prompt(page).locator(".prompt-ok").click();
  expect((await answers(page)).at(-1).answer).toEqual({ indexes: [0, 1] });
});

test("a name: checked as it is typed; a refusal keeps Enter from giving it, a warning does not", async ({ page }) => {
  await open(page);
  await ask(page, { kind: "input", title: "New branch from 0000303", placeholder: "Branch name", value: "feature/x" }, "toolbar-update");
  const box = prompt(page).locator(".prompt-input");
  await expect(box).toBeFocused();
  await expect(box).toHaveValue("feature/x");
  await expect(prompt(page).locator(".prompt-message")).toBeHidden();
  await box.fill("feature x");
  await expect(prompt(page).locator(".prompt-message")).toHaveText("A branch name cannot contain spaces.");
  await expect(box).toHaveAttribute("aria-invalid", "true");
  await page.keyboard.press("Enter");
  await expect(prompt(page)).toBeVisible();
  expect(await answers(page)).toEqual([]);
  await box.fill("feature/a-rather-long-name-for-a-short-lived-branch");
  await expect(prompt(page).locator(".prompt-message")).toHaveText("Long names are hard to read in the Log.");
  await expect(prompt(page).locator(".prompt-message")).not.toHaveClass(/blocking/);
  await page.keyboard.press("Enter");
  await expect(prompt(page)).toHaveCount(0);
  expect((await answers(page)).at(-1).answer).toEqual({ value: "feature/a-rather-long-name-for-a-short-lived-branch" });
});

test("a long list is filtered as you type; nothing left says so", async ({ page }) => {
  await open(page);
  await ask(page, { kind: "pick", title: "Switch profile", items: many(12) }, "toolbar-more");
  const filter = prompt(page).locator(".prompt-filter");
  await expect(filter).toBeFocused();
  await page.keyboard.type("mo");
  await expect(prompt(page).locator(".prompt-item")).toHaveText([/acme-mobile/]);
  await page.keyboard.press("Enter");
  expect((await answers(page)).at(-1).answer).toEqual({ index: 5 });
  await ask(page, { kind: "pick", title: "Switch profile", items: many(12) }, "toolbar-more");
  await page.keyboard.type("zz");
  await expect(prompt(page).locator(".prompt-empty")).toHaveText("No matches");
  await page.keyboard.press("Enter");
  await expect(prompt(page)).toBeVisible();
  // A short list has no filter.
  await page.keyboard.press("Escape");
  await ask(page, { kind: "pick", title: "Remote", items: many(3) }, "toolbar-more");
  await expect(prompt(page).locator(".prompt-filter")).toHaveCount(0);
  await expect(prompt(page).locator(".prompt-list")).toBeFocused();
});

test("a right-click writes its place into the menu's context VS Code reads, then puts it back", async ({ page }) => {
  await open(page);
  const row = page.locator('#rows .row[data-index="2"]');
  const before = await row.getAttribute("data-vscode-context");
  const seen = await row.evaluate((el) => {
    let during;
    window.addEventListener("contextmenu", () => { during = el.dataset.vscodeContext; }, { once: true });
    const r = el.getBoundingClientRect();
    el.querySelector(".subject").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 5 }));
    return { during, box: { x: Math.round(r.left + 200), y: Math.round(r.top + 5) } };
  });
  expect(JSON.parse(seen.during)).toEqual({ ...JSON.parse(before), at: [seen.box.x, seen.box.y], surface: "log" });
  await expect.poll(() => row.getAttribute("data-vscode-context")).toBe(before);
});

test("the arrow keys in the Log send no place: only what can lead to a question carries one", async ({ page }) => {
  await open(page);
  await page.locator('#rows .row[data-index="0"] .subject').click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  const sent = await page.evaluate(() => window.harnessMessages.filter((m) => m.type === "select"));
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.every((m) => m.at === undefined)).toBe(true);
});

for (const theme of ["light", "hc-dark", "hc-light"]) {
  test(`${theme}: opaque, its active choice marked, no errors`, async ({ page }) => {
    const errors = await open(page, { theme });
    await page.locator("#toolbar-update").click();
    const look = await prompt(page).evaluate((el) => {
      const active = el.querySelector(".prompt-item.active");
      return { bg: getComputedStyle(el).backgroundColor, outline: getComputedStyle(active).outlineStyle, activeBg: getComputedStyle(active).backgroundColor };
    });
    expect(look.bg).not.toMatch(/rgba\(.*, 0\)|transparent/);
    if (theme.startsWith("hc")) expect(look.outline).toBe("solid");
    else expect(look.activeBg).not.toBe(look.bg);
    expect(errors).toEqual([]);
  });
}

test("zh-cn: its own words are Chinese", async ({ page }) => {
  await open(page, { locale: "zh-cn" });
  await ask(page, { kind: "pickMany", title: "推送到 3 个仓库", items: many(3) }, "toolbar-push");
  await expect(prompt(page).locator(".prompt-ok")).toHaveText("确定");
  await expect(prompt(page).locator(".prompt-hint")).toHaveText("空格勾选，回车确定");
  await page.keyboard.press("Escape");
  await ask(page, { kind: "pick", title: "切换配置", items: many(12) }, "toolbar-more");
  await expect(prompt(page).locator(".prompt-filter")).toHaveAttribute("placeholder", "输入以筛选");
});

test("the Commit side bar's History asks under its button, as the Log does", async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 520 });
  await page.goto("/commit.html?theme=dark");
  const button = page.locator("#commit-history");
  await button.click();
  const sent = await page.evaluate(() => window.commitMessages.filter((m) => m.type === "history"));
  const b = await button.boundingBox();
  expect(sent.at(-1).at).toEqual({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) });
  // What the Commit panel's PromptPort sends back: the messages under the button.
  await page.evaluate((at) => window.postMessage({ type: "prompt", id: 1, at, request: { kind: "pick", title: "Commit Message History", items: [{ label: "feat: add retry to uploader" }, { label: "fix: guard nil response" }] } }, "*"), sent.at(-1).at);
  const p = await page.locator(".prompt").boundingBox();
  expect(p.y).toBeGreaterThanOrEqual(b.y + b.height);
  expect(p.y).toBeLessThan(b.y + b.height + 6);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect((await page.evaluate(() => window.commitMessages.filter((m) => m.type === "promptAnswer"))).at(-1)).toEqual({ type: "promptAnswer", id: 1, answer: { index: 1 } });
});

test("Stash Changes…: the switch under the box says what Enter does; ✨ writes into the box while it waits", async ({ page }) => {
  await open(page);
  const request = { kind: "input", title: "Stash Changes in acme-web", placeholder: "Stash message", value: "WIP", extra: "Write the stash message with AI",
    toggle: { label: "Include new files", on: false, says: ["Stashes the changes to tracked files; new files stay. Enter to stash.", "Stashes every change, new files included. Enter to stash."] } };
  await ask(page, request, { x: 200, y: 160, w: 0, h: 0 });
  const box = prompt(page).locator(".prompt-input"), says = prompt(page).locator(".prompt-says");
  await expect(says).toHaveText(/^Stashes the changes to tracked files/);
  await prompt(page).locator(".prompt-toggle").click();
  await expect(says).toHaveText(/^Stashes every change/);
  // ✨: busy (the box waits, the button spins), then the text, then done.
  await prompt(page).locator(".prompt-extra").click();
  await expect(box).toHaveJSProperty("readOnly", true);
  await expect(prompt(page)).toHaveAttribute("aria-busy", "true");
  await expect(box).toHaveValue("Save the upload retry, new files too");
  await expect(box).toHaveJSProperty("readOnly", false);
  const sent = await page.evaluate(() => window.harnessMessages.filter((m) => m.type === "promptExtra"));
  expect(sent.at(-1)).toMatchObject({ type: "promptExtra", on: true });
  await box.focus();
  await page.keyboard.press("Enter");
  expect((await answers(page)).at(-1).answer).toEqual({ value: "Save the upload retry, new files too", on: true });
});
