// The Linyra AI page (Configure AI…, Switch AI Model…, Remove AI Profile…) against the dev harness:
// the profiles, the form and its checks, the stored key, the model combobox, the thinking levels,
// Test Connection's report and Save, in every theme, wide and 360px narrow.
import { expect, test } from "@playwright/test";

const open = async (page, { theme = "dark", width = 900, height = 900, query = "", lang = "" } = {}) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.goto(`/aiSettings${lang}.html?theme=${theme}${query}`);
  await expect(page.locator("#ai-profiles, #ai-empty").locator("visible=true").first()).toBeVisible();
  return errors;
};
const sent = (page, type) => page.evaluate((t) => window.aiMessages.filter((m) => m.type === t), type);
const row = (page, id) => page.locator(`li[data-id="${id}"]`);
const editor = (page) => page.locator("#ai-editor");

test("lists the profiles: the one in use marked, each with Use, Edit and Remove…", async ({ page }) => {
  const errors = await open(page);
  await expect(page.locator(".ai-profile")).toHaveCount(3);
  const active = row(page, "ai-1");
  await expect(active).toHaveAttribute("aria-current", "true");
  await expect(active.locator(".ai-badge")).toHaveText("In use");
  await expect(active.locator('[data-action="use"]')).toHaveCount(0);
  await expect(active.locator(".ai-profile-facts")).toHaveText("Anthropic · api.anthropic.com · Thinking: High · Key stored");
  await expect(row(page, "ai-2").locator(".ai-profile-facts")).toHaveText("llama3.1:8b · OpenAI-compatible · localhost:11434 · Thinking: Default · No key");
  await expect(row(page, "ai-2").locator('[data-action="use"]')).toHaveAccessibleName("Use “Local llama”");
  await expect(page.locator("#ai-enabled-note")).toHaveText("On: uses “Anthropic · claude-opus-5-5”.");
  await expect(page.locator("#ai-enabled-note .ai-inline-icon")).toHaveCount(1);
  // Switch AI Model… opened it: the first profile to switch to has the focus.
  await expect(row(page, "ai-2").locator('[data-action="use"]')).toBeFocused();
  expect(errors).toEqual([]);
});

test("Use switches the profile in use with one click", async ({ page }) => {
  await open(page);
  await row(page, "ai-2").locator('[data-action="use"]').click();
  await expect(row(page, "ai-2").locator(".ai-badge")).toHaveText("In use");
  await expect(row(page, "ai-1").locator(".ai-badge")).toHaveCount(0);
  await expect(page.locator("#ai-status")).toHaveText("Linyra AI now uses Local llama.");
  await expect(row(page, "ai-2").locator('[data-action="edit"]')).toBeFocused();
  expect(await sent(page, "use")).toEqual([{ type: "use", id: "ai-2" }]);
});

test("Remove… asks in the row, says what goes and what is used next; Esc and Cancel keep it", async ({ page }) => {
  await open(page, { query: "&open=first" });
  const active = row(page, "ai-1");
  // Remove AI Profile… opened it: the first profile's Remove… has the focus.
  await expect(active.locator('[data-action="remove"]')).toBeFocused();
  await active.locator('[data-action="remove"]').click();
  const confirm = active.locator(".ai-confirm");
  await expect(confirm).toContainText("Remove the AI profile “Anthropic · claude-opus-5-5”?");
  await expect(confirm.locator(".ai-confirm-detail")).toHaveText(["Its API key is deleted from VS Code's secret storage.", "Linyra AI will use “Local llama” instead."]);
  await expect(confirm.locator('[data-action="confirmRemove"]')).toBeFocused();
  // Inside its row, never wider than it.
  const [box, li] = [await confirm.boundingBox(), await active.boundingBox()];
  expect(box.x + box.width).toBeLessThanOrEqual(li.x + li.width);
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(active.locator('[data-action="remove"]')).toBeFocused();
  await row(page, "ai-2").locator('[data-action="remove"]').click();
  await expect(row(page, "ai-2").locator(".ai-confirm-detail")).toHaveText(["It has no stored API key."]);
  await row(page, "ai-2").locator('[data-action="cancelRemove"]').click();
  await expect(page.locator(".ai-confirm")).toHaveCount(0);
  expect(await sent(page, "remove")).toEqual([]);
  await active.locator('[data-action="remove"]').click();
  await active.locator('[data-action="confirmRemove"]').click();
  await expect(page.locator(".ai-profile")).toHaveCount(2);
  await expect(page.locator("#ai-status")).toHaveText("Removed “Anthropic · claude-opus-5-5”.");
  await expect(row(page, "ai-2").locator(".ai-badge")).toHaveText("In use");
  await expect(row(page, "ai-2").locator("button").first()).toBeFocused();
  expect(await sent(page, "remove")).toEqual([{ type: "remove", id: "ai-1" }]);
});

test("with no profile the page says how to start, and Configure AI… opens the form", async ({ page }) => {
  const errors = await open(page, { query: "&state=empty&open=add" });
  await expect(page.locator("#ai-empty")).toContainText("No AI profile yet — add one to use in the Log.");
  await expect(page.locator("#ai-empty .ai-inline-icon")).toHaveCount(1);
  await expect(page.locator("#ai-profiles")).toBeHidden();
  await expect(page.locator("#ai-enabled")).toHaveAttribute("disabled", "");
  await expect(page.locator("#ai-enabled-note")).toHaveText("Add a profile first.");
  await expect(page.locator("#ai-add")).toHaveClass(/primary/);
  await expect(editor(page)).toBeVisible();
  await expect(page.locator("#ai-form-title")).toHaveText("Add Profile");
  await expect(page.locator('input[name="ai-protocol"][value="anthropic"]')).toBeChecked();
  await expect(page.locator('input[name="ai-protocol"][value="anthropic"]')).toBeFocused();
  await expect(page.locator("#ai-address-fixed")).toContainText("https://api.anthropic.com");
  await expect(page.locator("#ai-key")).toBeVisible();
  await expect(page.locator("#ai-key")).toHaveAttribute("type", "password");
  await expect(page.locator("#ai-model-note")).toHaveText("Enter the API key to load the model list, or type the model id.");
  await expect(page.locator("#ai-name")).toHaveAttribute("placeholder", "Anthropic · claude-opus-5-5");
  expect(await sent(page, "models")).toEqual([]);
  expect(errors).toEqual([]);
});

test("the form checks as you go: an error once the field is left, a warning that never blocks", async ({ page }) => {
  await open(page, { query: "&state=empty&open=add" });
  await page.locator('input[name="ai-protocol"][value="openai"]').check();
  const url = page.locator("#ai-base-url"), urlMsg = page.locator("#ai-base-url-msg");
  await url.fill("localhost:11434");
  await expect(urlMsg).toBeHidden();
  await url.blur();
  await expect(urlMsg).toHaveText("This is not an address. Start it with https:// or http://.");
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await page.locator("#ai-save").click();
  await expect(url).toBeFocused();
  expect(await sent(page, "save")).toEqual([]);
  await url.fill("http://gateway.example.com/v1");
  await expect(urlMsg).toHaveClass(/warning/);
  await expect(urlMsg).toContainText("not encrypted");
  await expect(url).toHaveAttribute("aria-invalid", "false");
  await page.locator("#ai-key").fill("sk-测试");
  await page.locator("#ai-key").blur();
  await expect(page.locator("#ai-key-msg")).toHaveText("An API key is plain ASCII text, and this one has other characters. Paste it again.");
  await page.locator("#ai-key").fill("sk-test-fake");
  await page.locator("#ai-save").click();
  await expect(page.locator("#ai-model-msg")).toHaveText("Enter a model id, or pick one from the list.");
  await expect(page.locator("#ai-model")).toBeFocused();
  expect(await sent(page, "save")).toEqual([]);
});

test("OpenAI-compatible offers the usual local servers; a local server needs no key", async ({ page }) => {
  await open(page, { query: "&state=empty&open=add" });
  await page.locator('input[name="ai-protocol"][value="openai"]').check();
  await expect(page.locator("#ai-base-url")).toHaveValue("https://api.openai.com/v1");
  await expect(page.locator(".ai-preset")).toHaveText(["OpenAI", "Ollama", "LM Studio"]);
  await expect(page.locator('.ai-preset[aria-pressed="true"]')).toHaveText("OpenAI");
  await page.locator(".ai-preset", { hasText: "Ollama" }).click();
  await expect(page.locator("#ai-base-url")).toHaveValue("http://localhost:11434/v1");
  await expect(page.locator("#ai-key-note")).toHaveText("A server on this machine or your network often needs no key: leave it empty.");
  await expect(page.locator("#ai-name"), "no half a name before there is a model").toHaveAttribute("placeholder", "");
  await page.locator("#ai-model").fill("llama3.1:8b");
  await expect(page.locator("#ai-name")).toHaveAttribute("placeholder", "localhost:11434 · llama3.1:8b");
  await page.locator("#ai-model").fill("");
  await expect(page.locator("#ai-model-note")).toHaveText("4 models from localhost:11434: open the list with ↓ or type to filter.");
  const models = await sent(page, "models");
  expect(models.at(-1)).toMatchObject({ draft: { protocol: "openai", baseUrl: "http://localhost:11434/v1" }, key: { kind: "none" } });
  await page.locator("#ai-key").blur();
  await expect(page.locator("#ai-key-msg")).toBeHidden();
});

test("a stored key shows as stored with Replace and Remove; the page never holds it", async ({ page }) => {
  await open(page);
  await row(page, "ai-1").locator('[data-action="edit"]').click();
  await expect(page.locator("#ai-form-title")).toHaveText("Edit “Anthropic · claude-opus-5-5”");
  await expect(row(page, "ai-1").locator(".ai-badge.outline")).toHaveText("Editing");
  await expect(page.locator("#ai-key-stored")).toContainText("Stored for api.anthropic.com");
  await expect(page.locator("#ai-key-stored")).toHaveAccessibleName("API key Stored for api.anthropic.com");
  await expect(page.locator("#ai-key-replace")).toHaveAccessibleName("Replace the stored API key");
  await expect(page.locator("#ai-key-remove")).toHaveAccessibleName("Remove the stored API key");
  await expect(page.locator("#ai-key")).toBeHidden();
  await expect(page.locator("#ai-use-field")).toBeHidden();
  await expect(page.locator('#ai-efforts input[value="high"]')).toBeChecked();
  await page.locator("#ai-key-replace").click();
  await expect(page.locator("#ai-key")).toBeFocused();
  await expect(page.locator("#ai-key-note")).toHaveText("Leave it empty to keep the stored key.");
  await page.locator("#ai-key-cancel").click();
  await expect(page.locator("#ai-key-stored")).toBeVisible();
  await expect(page.locator("#ai-key-replace")).toBeFocused();
  await page.locator("#ai-key-remove").click();
  await expect(page.locator("#ai-key-note")).toHaveText("The stored key is deleted when you save.");
  await page.locator("#ai-save").click();
  await expect(editor(page)).toBeHidden();
  expect((await sent(page, "save")).map((m) => m.key)).toEqual([{ kind: "none" }]);
  await expect(row(page, "ai-1").locator(".ai-profile-facts")).toContainText("No key");
});

test("a key typed again replaces it; Save sends it once and keeps the field a password", async ({ page }) => {
  await open(page);
  await row(page, "ai-3").locator('[data-action="edit"]').click();
  await page.locator("#ai-key-replace").click();
  await page.locator("#ai-key").fill("AIza-test-fake");
  await page.locator("#ai-key").press("Enter");
  await expect(editor(page)).toBeHidden();
  const saves = await sent(page, "save");
  expect(saves).toEqual([{ type: "save", draft: { id: "ai-3", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3-pro", effort: "low", label: "" },
    key: { kind: "new", value: "AIza-test-fake" }, use: false }]);
  await expect(page.locator("#ai-status")).toHaveText("Saved “Gemini · gemini-3-pro”.");
  await expect(row(page, "ai-3").locator('[data-action="edit"]')).toBeFocused();
  await expect(page.locator("#ai-key")).toHaveValue("");
});

test("an address on another origin never gets the stored key", async ({ page }) => {
  await open(page);
  await row(page, "ai-1").locator('[data-action="edit"]').click();
  await page.locator("#ai-address-custom").click();
  await expect(page.locator("#ai-base-url")).toBeFocused();
  await page.locator("#ai-base-url").fill("https://gateway.example.com");
  await expect(page.locator("#ai-key")).toBeVisible();
  await page.locator("#ai-key").focus();
  await page.locator("#ai-key").blur();
  await expect(page.locator("#ai-key-msg")).toHaveText("The key stored for https://api.anthropic.com is never sent to https://gateway.example.com, and saving deletes it. Enter a key for this address.");
  await expect(page.locator("#ai-address-reset")).toHaveText("Use api.anthropic.com");
  await page.locator("#ai-address-reset").click();
  await expect(page.locator("#ai-key-stored")).toContainText("Stored for api.anthropic.com");
  await expect(page.locator("#ai-address-custom")).toBeFocused();
});

test("the model combobox: ↓ opens the provider's list, typing filters, Enter picks; any id works", async ({ page }) => {
  await open(page, { query: "&open=add" });
  const model = page.locator("#ai-model");
  await expect(page.locator("#ai-model-note")).toHaveText("4 models from api.anthropic.com: open the list with ↓ or type to filter.");
  await model.fill("son");
  const rows = page.locator("#ai-model-suggestions .suggest-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("claude-sonnet-5-5Claude Sonnet 5.5 · 1M context");
  await expect(rows.first().locator(".suggest-hit")).toHaveText("son");
  await expect(model).toHaveAttribute("aria-expanded", "true");
  await model.press("ArrowDown");
  await model.press("Enter");
  await expect(model).toHaveValue("claude-sonnet-5-5");
  await expect(model).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#ai-efforts input")).toHaveCount(6);
  await model.fill("claude-sonnet-5-5");
  await page.locator("#ai-model-open").click();
  await expect(rows).toHaveCount(4);
  await model.press("Escape");
  await model.fill("my-own-model");
  await expect(page.locator("#ai-model-suggestions .suggest-hint")).toHaveText("No listed model matches my-own-model: it is used as typed.");
  await model.press("Enter");
  await expect(model).toHaveAttribute("aria-expanded", "false");
  expect(await sent(page, "save")).toEqual([]);
  await expect(model).toHaveValue("my-own-model");
});

test("the thinking levels follow the model, and say when it takes none or the provider does not tell", async ({ page }) => {
  await open(page, { query: "&open=add" });
  const levels = page.locator("#ai-efforts .ai-segment");
  await expect(levels).toHaveText(["Default", "Low", "Medium", "High", "Extra High", "Max"]);
  await page.locator("#ai-efforts .ai-segment", { hasText: "Max" }).click();
  await expect(page.locator("#ai-effort-note")).toHaveText("Higher levels think longer: better on hard questions, slower and more tokens.");
  await page.locator("#ai-model").fill("claude-opus-4-5");
  await expect(levels).toHaveText(["Default", "Low", "Medium", "High"]);
  await expect(page.locator('#ai-efforts input[value="default"]')).toBeChecked();
  await page.locator("#ai-model").fill("claude-opus-5-5");
  await expect(page.locator('#ai-efforts input[value="max"]')).toBeChecked();
  await page.locator('input[name="ai-protocol"][value="openai"]').check();
  await page.locator("#ai-model").fill("gpt-4o");
  await expect(page.locator("#ai-efforts")).toBeHidden();
  await expect(page.locator("#ai-effort-note")).toHaveText("gpt-4o does not take a thinking level.");
  await page.locator("#ai-model").fill("llama3.1:8b");
  await expect(page.locator("#ai-effort-note")).toHaveText("The provider does not say which levels llama3.1:8b takes: Test Connection shows whether one works.");
  // The arrows move between the levels, as in any radio group.
  await page.locator('#ai-efforts input[value="default"]').focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('#ai-efforts input[value="none"]')).toBeChecked();
});

test("a model list that cannot be read says why, and the field stays free text", async ({ page }) => {
  await open(page, { query: "&open=add&models=fail" });
  await expect(page.locator("#ai-model-note")).toHaveText("The model list could not be read. Could not connect to localhost:11434: nothing is listening there. Is the server running? You can still type the model id.");
  await page.locator("#ai-model").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#ai-model-suggestions .suggest-hint")).toContainText("The model list could not be read.");
  await page.locator("#ai-model-reload").click();
  await expect.poll(async () => (await sent(page, "models")).length).toBe(2);
});

test("a model list refused for its key says so in the page's words", async ({ page }) => {
  await open(page, { query: "&models=auth" });
  await row(page, "ai-1").locator('[data-action="edit"]').click();
  await expect(page.locator("#ai-model-note")).toHaveText("api.anthropic.com did not accept the API key (401). Check the key, or replace it with a new one from the provider's console.");
});

test("a typed key is sent only where it was typed: never while typing, and an address elsewhere clears it", async ({ page }) => {
  await open(page, { query: "&state=empty&open=add" });
  await page.locator('input[name="ai-protocol"][value="openai"]').check();
  await page.locator("#ai-key").fill("sk-test-fake");
  await page.waitForTimeout(800);
  expect(await sent(page, "models"), "nothing goes out while the key is typed").toEqual([]);
  await expect(page.locator("#ai-model-note")).toHaveText("Open the list (↓) to load the models of api.openai.com.");
  await page.locator(".ai-preset", { hasText: "Ollama" }).click();
  await expect(page.locator("#ai-key")).toHaveValue("");
  await expect(page.locator("#ai-key-note")).toHaveText("The key you typed was for api.openai.com, so it was cleared. Type it again for this address.");
  const typedKeySent = async () => (await sent(page, "models")).filter((m) => m.key.kind === "new");
  await page.locator("#ai-key").fill("sk-local-fake");
  await page.locator("#ai-base-url").fill("http://localhost:11434/v1/");
  await expect(page.locator("#ai-key"), "the same origin keeps it").toHaveValue("sk-local-fake");
  // Past every debounce: a load the page scheduled before the key was typed must not take the key with it.
  await page.waitForTimeout(800);
  expect(await typedKeySent(), "nothing goes out while the key is typed").toEqual([]);
  await page.locator("#ai-base-url").fill("http://localhost:1234/v1");
  await expect(page.locator("#ai-key"), "another port is another origin").toHaveValue("");
  await page.locator("#ai-key").fill("sk-local-fake");
  await page.waitForTimeout(800);
  expect(await typedKeySent(), "nor after the address moved and the key was typed again").toEqual([]);
  // Opening the list is what sends it: once, to the address it was typed for.
  await page.locator("#ai-model").focus();
  await expect.poll(async () => (await typedKeySent()).map((m) => [m.draft.baseUrl, m.key.value])).toEqual([["http://localhost:1234/v1", "sk-local-fake"]]);
  await expect(page.locator("#ai-model-note")).toHaveText("4 models from localhost:1234: open the list with ↓ or type to filter.");
});

test("a model list asked for the form before is dropped when it arrives", async ({ page }) => {
  await open(page, { query: "&open=add" });
  await expect.poll(async () => (await sent(page, "models")).length).toBe(1);
  await page.locator('input[name="ai-protocol"][value="openai"]').check();
  await page.waitForTimeout(300);
  await page.locator("#ai-model").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#ai-model-suggestions .suggest-hint")).toHaveText("Enter the API key to load the model list, or type the model id.");
  await expect(page.locator("#ai-model-suggestions .suggest-row")).toHaveCount(0);
  await expect(page.locator("#ai-model-note")).toHaveText("Enter the API key to load the model list, or type the model id.");
});

test("a save answers the form that sent it; Cancel waits for it", async ({ page }) => {
  await open(page, { query: "&save=slow" });
  await row(page, "ai-2").locator('[data-action="edit"]').click();
  await page.locator("#ai-save").click();
  await expect(page.locator("#ai-save")).toHaveText("Saving…");
  await expect(page.locator("#ai-cancel")).toBeDisabled();
  await row(page, "ai-3").locator('[data-action="edit"]').click();
  await expect(page.locator("#ai-form-title")).toHaveText("Edit “Gemini · gemini-3-pro”");
  await expect(page.locator("#ai-status")).toHaveText("Saved “Local llama”.");
  await expect(editor(page), "the other form stays open").toBeVisible();
  await expect(page.locator("#ai-form-title")).toHaveText("Edit “Gemini · gemini-3-pro”");
  await expect(page.locator("#ai-save")).toHaveText("Save");
  await expect(page.locator("#ai-cancel")).toBeEnabled();
});

test("a screen reader hears what happened, through one live region that is always there", async ({ page }) => {
  await open(page, { query: "&test=auth" });
  const live = page.locator("#ai-announce");
  await expect(live).toHaveAttribute("role", "status");
  await expect(live).toBeAttached();
  await row(page, "ai-2").locator('[data-action="use"]').click();
  await expect(live).toHaveText("Linyra AI now uses Local llama.");
  await row(page, "ai-1").locator('[data-action="edit"]').click();
  await page.locator("#ai-test").click();
  await expect(live).toContainText("The test failed. api.anthropic.com did not accept the API key (401).");
  await expect(page.locator("#ai-status")).not.toHaveAttribute("role", "status");
});

test("Test Connection says what worked, then what failed and what to do next", async ({ page }) => {
  await open(page, { query: "&open=add&test=auth" });
  await page.locator("#ai-test").click();
  const result = page.locator("#ai-test-result");
  await expect(result.locator("#ai-test-title")).toHaveText("The test failed.");
  await expect(result.locator(".ai-result-line")).toHaveCount(2);
  await expect(result.locator(".ai-result-line.failed")).toContainText("api.anthropic.com did not accept the API key (401).");
  await expect(result.locator(".ai-result-line.failed")).toContainText("Check the key, or replace it with a new one from the provider's console.");
  await expect(result.locator(".ai-result-line.failed .ai-result-detail")).toHaveText("The provider says: invalid x-api-key");
  await expect(result.locator(".ai-result-line.skipped")).toHaveText("claude-opus-5-5 was not tried: the step above has to work first.");
  expect((await sent(page, "test"))[0]).toMatchObject({ draft: { protocol: "anthropic", model: "claude-opus-5-5" }, key: { kind: "from", profileId: "ai-1" } });
  // Changing what was tested takes the report away.
  await page.locator("#ai-model").fill("claude-sonnet-5-5");
  await expect(result).toBeHidden();
});

test("a level the model does not take is named; a gateway without a model list still passes", async ({ page }) => {
  await open(page, { query: "&test=level" });
  await row(page, "ai-1").locator('[data-action="edit"]').click();
  await page.locator("#ai-test").click();
  await expect(page.locator(".ai-result-line.ok")).toHaveText("Reached api.anthropic.com and the key was accepted (4 models).");
  await expect(page.locator(".ai-result-line.failed")).toContainText("claude-opus-5-5 may not take the thinking level High: try Default.");
  await page.goto("/aiSettings.html?theme=dark&test=nolist&open=add");
  await page.locator("#ai-test").click();
  await expect(page.locator("#ai-test-title")).toHaveText("The connection works.");
  await expect(page.locator(".ai-result-line.warning")).toHaveText("api.anthropic.com does not list its models: type the model id.");
  await expect(page.locator(".ai-result-line.ok")).toHaveText("claude-opus-5-5 answered in 640 ms.");
});

test("a running test can be stopped", async ({ page }) => {
  await open(page, { query: "&open=add&test=slow" });
  await page.locator("#ai-test").click();
  await expect(page.locator("#ai-test")).toHaveText("Stop Test");
  await expect(page.locator("#ai-test-progress")).toHaveText("Checking the address and the key…");
  await page.locator("#ai-test").click();
  await expect(page.locator("#ai-test")).toHaveText("Test Connection");
  await expect(page.locator("#ai-test-progress")).toHaveText("");
  expect(await sent(page, "stopTest")).toHaveLength(1);
});

test("Save sends the checked profile, closes the form and puts the new row in use", async ({ page }) => {
  await open(page);
  await page.locator("#ai-add").click();
  await page.locator('input[name="ai-protocol"][value="openai"]').check();
  await page.locator(".ai-preset", { hasText: "Ollama" }).click();
  await page.locator("#ai-model").fill("qwen2.5-coder:7b");
  await page.locator("#ai-name").fill("  Coder ");
  await page.locator("#ai-save").click();
  await expect(editor(page)).toBeHidden();
  expect(await sent(page, "save")).toEqual([{ type: "save", draft: { protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder:7b", effort: "default", label: "Coder" }, key: { kind: "none" }, use: true }]);
  await expect(page.locator(".ai-profile")).toHaveCount(4);
  await expect(page.locator("#ai-status")).toHaveText("Saved. Linyra AI now uses Coder.");
  const coder = page.locator(".ai-profile", { hasText: "Coder" });
  await expect(coder.locator(".ai-badge")).toHaveText("In use");
  await expect(coder.locator('[data-action="edit"]')).toBeFocused();
});

test("a save that fails keeps the form and says why; Cancel goes back to the list", async ({ page }) => {
  await open(page, { query: "&save=fail" });
  await row(page, "ai-2").locator('[data-action="edit"]').click();
  await page.locator("#ai-save").click();
  await expect(page.locator("#ai-save-error")).toHaveText("Unable to write to User Settings because the file has unsaved changes.");
  await expect(editor(page)).toBeVisible();
  await expect(page.locator("#ai-save")).toBeEnabled();
  await page.locator("#ai-cancel").click();
  await expect(editor(page)).toBeHidden();
  await expect(row(page, "ai-2").locator('[data-action="edit"]')).toBeFocused();
});

test("the AI switch turns the features off and on", async ({ page }) => {
  await open(page);
  await page.locator("#ai-enabled").click();
  await expect(page.locator("#ai-enabled-note")).toHaveText("Off: nothing is sent to any AI provider.");
  await expect(row(page, "ai-1").locator(".ai-badge")).toHaveText("Chosen · AI is off");
  await page.locator("#ai-enabled").press("Space");
  await expect(page.locator("#ai-status")).toHaveText("Linyra AI is on.");
  expect(await sent(page, "enable")).toEqual([{ type: "enable", on: false }, { type: "enable", on: true }]);
  await page.locator("#ai-more").click();
  expect(await sent(page, "moreSettings")).toHaveLength(1);
});

test("the provider radios move with the arrow keys and keep a typed gateway address", async ({ page }) => {
  await open(page, { query: "&open=add" });
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('input[name="ai-protocol"][value="gemini"]')).toBeChecked();
  await expect(page.locator("#ai-address-fixed")).toContainText("https://generativelanguage.googleapis.com/v1beta");
  await expect(page.locator("#ai-model")).toHaveValue("");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator('input[name="ai-protocol"][value="openai"]')).toBeChecked();
  await page.locator("#ai-base-url").fill("https://gateway.example.com/v1");
  await page.locator('input[name="ai-protocol"][value="anthropic"]').check();
  await expect(page.locator("#ai-base-url")).toHaveValue("https://gateway.example.com/v1");
  await expect(page.locator("#ai-address-edit")).toBeVisible();
});

test("reads in Chinese", async ({ page }) => {
  const errors = await open(page, { lang: ".zh-cn", query: "&open=add&test=auth" });
  await expect(page.locator("#ai-form-title")).toHaveText("添加配置");
  await expect(page.locator("#ai-test")).toHaveText("测试连接");
  await page.locator("#ai-test").click();
  await expect(page.locator("#ai-test-title")).toHaveText("测试失败。");
  await expect(page.locator(".ai-result-line.failed")).toContainText("没有接受这个 API 密钥（401）");
  await expect(row(page, "ai-1").locator(".ai-badge")).toHaveText("正在使用");
  expect(errors).toEqual([]);
});

/** WCAG contrast of an element's text against what is drawn under it (translucent layers composited). */
const contrastOf = (page, selector) => page.locator(selector).first().evaluate((el) => {
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r, g, b, a };
  };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  const layers = [];
  for (let node = el; node; node = node.parentElement) {
    const bg = parse(getComputedStyle(node).backgroundColor);
    if (bg && bg.a > 0) layers.push(bg);
    if (bg && bg.a >= 1) break;
  }
  let bg = { r: 255, g: 255, b: 255, a: 1 };
  for (const layer of layers.reverse()) bg = over(layer, bg);
  const fg = over(parse(getComputedStyle(el).color), bg);
  const lum = ({ r, g, b }) => {
    const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  };
  const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
});

for (const theme of ["dark", "light", "hc-dark", "hc-light"]) {
  for (const width of [900, 360]) {
    test(`${theme}, ${width}px: no errors, no sideways scroll, readable text, a visible focus`, async ({ page }) => {
      const errors = await open(page, { theme, width, query: "&test=level" });
      await row(page, "ai-1").locator('[data-action="edit"]').click();
      await page.locator("#ai-address-custom").click();
      await page.locator("#ai-base-url").fill("http://gateway.example.com");
      await page.locator("#ai-base-url").blur();
      await page.locator("#ai-key").fill("sk-ant-test-fake");
      await page.locator("#ai-test").click();
      await expect(page.locator("#ai-test-result")).toBeVisible();
      await row(page, "ai-2").locator('[data-action="remove"]').click();
      await expect(page.locator(".ai-message.warning")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const selector of [".ai-title", ".ai-lede", "#ai-enabled-note", ".ai-profile-name", ".ai-profile-facts", ".ai-badge", '.ai-profile [data-action="edit"]',
        ".ai-provider-name", ".ai-provider:has(input:checked) .ai-provider-detail", ".ai-provider:not(:has(input:checked)) .ai-provider-detail", ".ai-hint",
        ".ai-segment input:checked + span", ".ai-segment input:not(:checked) + span", "#ai-save", "#ai-cancel", ".ai-result-text", ".ai-result-detail", ".ai-label", ".ai-message.warning", ".ai-confirm-question", ".ai-confirm-detail", ".ai-mono"]) {
        const ratio = await contrastOf(page, selector);
        expect(ratio, `${selector} in ${theme}`).toBeGreaterThanOrEqual(4.5);
      }
      await page.locator("#ai-model").focus();
      expect(await page.locator("#ai-model").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
      await page.locator("#ai-save").focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      expect(await page.locator("#ai-save").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
      for (const id of ["#ai-save", "#ai-test", "#ai-model", "#ai-key", "#ai-base-url"]) {
        const box = await page.locator(id).boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      expect(errors).toEqual([]);
    });
  }
}

test("VS Code's default webview padding cannot push the page off the tab", async ({ page }) => {
  await open(page, { width: 360 });
  await page.addStyleTag({ content: "body { padding: 0 20px; }" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
