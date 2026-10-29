import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { configureI18n } from "../i18n";
import { httpError } from "./errors";
import {
  activeAfterSave, checkDraft, checkForm, checkKeyChoice, contextText, draftName, draftOf, duration, effortNote, effortView, filterModels, fitEffort,
  isDefaultAddress, keyChoice, keyMessage, keyNote, keyState, modelDescription, modelsNote, modelsReadable, newDraft, profileFacts, profileOf,
  removalText, showsStoredKey, storedKeyText, testReport, withProtocol, type KeyState,
} from "./settingsModel";
import type { DraftProfile, ProfileRow, StepResult } from "./settingsProtocol";

configureI18n("en");

const row = (over: Partial<ProfileRow> & { id: string }): ProfileRow => ({
  label: `${over.id} label`, protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", effort: "default",
  key: { stored: true, origin: "https://api.anthropic.com" }, ...over,
});
const draft = (over: Partial<DraftProfile> = {}): DraftProfile => ({ ...newDraft("anthropic"), ...over });

{
  assert.deepStrictEqual(newDraft(), { protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", effort: "default", label: "" });
  assert.deepStrictEqual(newDraft("openai"), { protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "", effort: "default", label: "" });
  const generated = row({ id: "a", label: "Anthropic · claude-opus-5-5" });
  assert.strictEqual(draftOf(generated).label, "", "a generated name shows empty, so it follows the model");
  assert.strictEqual(draftOf(row({ id: "b", label: "Work Opus" })).label, "Work Opus");
  assert.strictEqual(draftName(draft({ model: "claude-sonnet-5-5" })), "Anthropic · claude-sonnet-5-5");
  assert.strictEqual(draftName(draft({ protocol: "openai", baseUrl: "http://localhost:11434/v1/", model: "llama3" })), "localhost:11434 · llama3");
  assert.strictEqual(draftName(draft({ label: "  mine " })), "mine");
  console.log("ok - a new draft starts from the provider's defaults; an edited one keeps a typed name only");
}

{
  const anthropic = draft({ model: "claude-opus-5-5", effort: "high" });
  const openai = withProtocol(anthropic, "openai");
  assert.deepStrictEqual([openai.baseUrl, openai.model, openai.effort], ["https://api.openai.com/v1", "", "default"], "the old default address follows the provider; the model starts over");
  const gateway = withProtocol(draft({ baseUrl: "https://gateway.example.com/anthropic" }), "openai");
  assert.strictEqual(gateway.baseUrl, "https://gateway.example.com/anthropic", "an address the user typed stays");
  assert.strictEqual(withProtocol(draft({ baseUrl: "" }), "gemini").baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.strictEqual(withProtocol(anthropic, "anthropic"), anthropic);
  assert.ok(isDefaultAddress(draft({ baseUrl: "https://api.anthropic.com/" })), "a trailing slash is still the default");
  assert.ok(!isDefaultAddress(draft({ baseUrl: "https://gateway.example.com" })));
  console.log("ok - switching provider swaps a default address, keeps a typed one, and starts the model over");
}

{
  const own = row({ id: "own", key: { stored: true, origin: "https://api.anthropic.com" } });
  const other = row({ id: "other", label: "Team Opus", key: { stored: true, origin: "https://gateway.example.com" } });
  const local = row({ id: "local", protocol: "openai", baseUrl: "http://localhost:11434/v1", key: { stored: false } });
  const profiles = [own, other, local];
  assert.deepStrictEqual(keyState({ id: "own", protocol: "anthropic", baseUrl: "https://api.anthropic.com" }, profiles), { kind: "stored", origin: "https://api.anthropic.com" });
  const moved = keyState({ id: "own", protocol: "anthropic", baseUrl: "https://gateway.example.com/v1" }, profiles);
  assert.strictEqual(moved.kind, "shared", "another profile of the same provider has a key for the new origin");
  assert.strictEqual((moved as Extract<KeyState, { kind: "shared" }>).from.id, "other");
  assert.deepStrictEqual(keyState({ id: "own", protocol: "anthropic", baseUrl: "https://elsewhere.example.com" }, profiles), { kind: "elsewhere", origin: "https://api.anthropic.com" });
  assert.deepStrictEqual(keyState({ id: "own", protocol: "anthropic", baseUrl: "https://api.anth" }, profiles).kind, "elsewhere", "a half-typed but valid address is another origin");
  assert.deepStrictEqual(keyState({ id: "own", protocol: "anthropic", baseUrl: "api.anthropic" }, profiles), { kind: "stored", origin: "https://api.anthropic.com" }, "not an address yet: the line stays");
  assert.strictEqual(keyState({ protocol: "anthropic", baseUrl: "https://api.anthropic.com" }, profiles).kind, "shared", "a new profile reuses a key for the same address");
  assert.strictEqual(keyState({ protocol: "openai", baseUrl: "https://api.anthropic.com" }, profiles).kind, "none", "never another provider's key");
  assert.strictEqual(keyState({ id: "local", protocol: "openai", baseUrl: "http://localhost:11434/v1" }, profiles).kind, "none");
  assert.strictEqual(storedKeyText({ kind: "stored", origin: "https://api.anthropic.com" }), "Stored for api.anthropic.com");
  assert.strictEqual(storedKeyText(moved), "Uses the key stored for “Team Opus”");
  console.log("ok - a stored key is offered only for the origin it was entered for, from the profile itself or one of the same provider");
}

{
  const stored: KeyState = { kind: "stored", origin: "https://api.anthropic.com" };
  const shared: KeyState = { kind: "shared", from: row({ id: "x" }), origin: "https://api.anthropic.com" };
  assert.deepStrictEqual(keyChoice(stored, "auto", "ignored"), { kind: "keep" }, "the field is hidden: what it held does not count");
  assert.deepStrictEqual(keyChoice(stored, "replace", ""), { kind: "keep" }, "Replace left empty keeps the stored key");
  assert.deepStrictEqual(keyChoice(stored, "replace", "  sk-ant-test  "), { kind: "new", value: "sk-ant-test" });
  assert.deepStrictEqual(keyChoice(stored, "remove", ""), { kind: "none" });
  assert.deepStrictEqual(keyChoice(stored, "remove", "sk-new"), { kind: "new", value: "sk-new" });
  assert.deepStrictEqual(keyChoice(shared, "auto", ""), { kind: "from", profileId: "x" });
  assert.deepStrictEqual(keyChoice({ kind: "none" }, "auto", ""), { kind: "none" });
  assert.deepStrictEqual(keyChoice({ kind: "elsewhere", origin: "https://a.example.com" }, "auto", "sk-1"), { kind: "new", value: "sk-1" });
  assert.ok(showsStoredKey(stored, "auto") && !showsStoredKey(stored, "replace") && !showsStoredKey({ kind: "none" }, "auto"));
  console.log("ok - the key choice: keep, copy from another profile, a typed key, or none");
}

{
  const remote = draft();
  const local = draft({ protocol: "openai", baseUrl: "http://localhost:11434/v1" });
  assert.strictEqual(keyMessage(remote, { kind: "none" }, { kind: "none" })?.severity, "warning", "no key for a remote provider");
  assert.strictEqual(keyMessage(local, { kind: "none" }, { kind: "none" }), undefined, "a local server often needs none");
  assert.strictEqual(keyMessage(remote, { kind: "none" }, { kind: "new", value: "sk-ant-测试" })?.severity, "error", "a header cannot carry it");
  assert.strictEqual(keyMessage(remote, { kind: "none" }, { kind: "new", value: "sk-ant a" })?.severity, "warning");
  assert.strictEqual(keyMessage(remote, { kind: "none" }, { kind: "new", value: "sk-ant-fake" }), undefined);
  const elsewhere = keyMessage(draft({ baseUrl: "https://gateway.example.com" }), { kind: "elsewhere", origin: "https://api.anthropic.com" }, { kind: "none" });
  assert.ok(elsewhere?.text.includes("https://api.anthropic.com") && elsewhere.text.includes("https://gateway.example.com"), elsewhere?.text);
  assert.ok(keyNote(local, { kind: "none" }, "auto").includes("often needs no key"));
  assert.ok(keyNote(remote, { kind: "none" }, "auto").includes("secret storage"));
  assert.ok(keyNote(remote, { kind: "stored", origin: "https://api.anthropic.com" }, "replace").includes("keep the stored key"));
  assert.ok(keyNote(remote, { kind: "stored", origin: "https://api.anthropic.com" }, "remove").includes("deleted when you save"));
  console.log("ok - the key field warns before a 401 and refuses characters a header cannot carry");
}

{
  const profiles = [row({ id: "a", label: "Anthropic · claude-opus-5-5" })];
  const ok = checkForm(draft(), [], { kind: "none" }, { kind: "new", value: "sk-ant-fake" });
  assert.deepStrictEqual(ok, { ok: true, key: undefined }, "nothing to say");
  const bad = checkForm(draft({ baseUrl: "api.example.com", model: " " }), [], { kind: "none" }, { kind: "none" });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.baseUrl?.severity, "error");
  assert.ok(bad.baseUrl?.text.includes("https://"));
  assert.strictEqual(checkForm(draft({ baseUrl: "localhost:11434" }), [], { kind: "none" }, { kind: "none" }).baseUrl?.text,
    "This is not an address. Start it with https:// or http://.", "a missing scheme is said as such, not as a wrong one");
  assert.strictEqual(checkForm(draft({ baseUrl: "ftp://files.example.com" }), [], { kind: "none" }, { kind: "none" }).baseUrl?.text, "Use an https:// or http:// address.");
  assert.strictEqual(bad.model?.severity, "error");
  assert.strictEqual(checkForm(draft({ baseUrl: "https://user:pw@api.example.com" }), [], { kind: "none" }, { kind: "none" }).baseUrl?.text,
    "Leave the key out of the address: the API key field takes it.");
  const plain = checkForm(draft({ baseUrl: "http://gateway.example.com" }), [], { kind: "none" }, { kind: "new", value: "k" });
  assert.deepStrictEqual([plain.ok, plain.baseUrl?.severity], [true, "warning"], "http:// to another machine warns, never blocks");
  assert.strictEqual(checkForm(draft({ model: "claude opus" }), [], { kind: "none" }, { kind: "new", value: "k" }).model?.severity, "warning");
  const same = checkForm(draft(), profiles, { kind: "shared", from: profiles[0], origin: "https://api.anthropic.com" }, { kind: "from", profileId: "a" });
  assert.deepStrictEqual([same.ok, same.label?.severity], [true, "info"], "the same name twice is a hint");
  assert.strictEqual(checkForm(draft({ id: "a" }), profiles, { kind: "none" }, { kind: "none" }).label, undefined, "its own name is no clash");
  assert.strictEqual(checkForm(draft({ label: "x".repeat(121) }), [], { kind: "none" }, { kind: "new", value: "k" }).ok, false);
  console.log("ok - the form's checks: errors block Save, warnings and hints only say");
}

{
  assert.strictEqual(modelsReadable(draft({ baseUrl: "nope" }), { kind: "keep" }), "address");
  assert.strictEqual(modelsReadable(draft(), { kind: "none" }), "key");
  assert.strictEqual(modelsReadable(draft({ baseUrl: "http://127.0.0.1:1234/v1" }), { kind: "none" }), "yes");
  assert.strictEqual(modelsReadable(draft(), { kind: "keep" }), "yes");
  assert.strictEqual(modelsNote({ state: "loading" }, "yes", "https://api.anthropic.com")?.text, "Fetching the models of api.anthropic.com…");
  assert.strictEqual(modelsNote({ state: "loaded", count: 1 }, "yes", "https://api.anthropic.com")?.text, "1 model from api.anthropic.com: open the list with ↓ or type to filter.");
  assert.strictEqual(modelsNote({ state: "loaded", count: 0 }, "yes", "https://api.anthropic.com")?.severity, "warning");
  assert.ok(modelsNote({ state: "failed", error: "Not found (404)." }, "yes", "https://x.example.com")?.text.endsWith("Not found (404)."));
  assert.ok(modelsNote({ state: "idle" }, "key", "https://x.example.com")?.text.includes("API key"));
  assert.strictEqual(modelsNote({ state: "failed", error: "x" }, "address", "nope"), undefined, "the address says what is wrong");
  console.log("ok - the model list loads when it can, and its line says why it cannot");
}

{
  const models = [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", contextTokens: 1_000_000 },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextTokens: 200_000 },
    { id: "meta/llama-3-opus", label: "Llama" },
    { id: "qwen:7b" },
  ];
  assert.deepStrictEqual(filterModels(models, "").map((m) => m.id), models.map((m) => m.id));
  assert.deepStrictEqual(filterModels(models, "claude-opus-5-5").length, 4, "a chosen model lists every model");
  assert.deepStrictEqual(filterModels(models, "opus").map((m) => m.id), ["claude-opus-5-5", "meta/llama-3-opus"]);
  assert.deepStrictEqual(filterModels(models, "LLAMA").map((m) => m.id), ["meta/llama-3-opus"], "a segment after / starts it");
  assert.deepStrictEqual(filterModels(models, "7b").map((m) => m.id), ["qwen:7b"]);
  assert.deepStrictEqual(filterModels(models, "sonnet 5").map((m) => m.id), ["claude-sonnet-5-5"], "the name counts too");
  assert.strictEqual(modelDescription(models[0]), "Claude Opus 5.5 · 1M context");
  assert.strictEqual(modelDescription({ id: "x", label: "x", contextTokens: 131_072 }), "131K context");
  assert.strictEqual(modelDescription({ id: "x" }), "");
  assert.strictEqual(contextText(1_048_576), "1M context");
  assert.strictEqual(contextText(2_097_152), "2.1M context");
  console.log("ok - the model list filters by id segment first, then any part of the id or name");
}

{
  const opus = effortView("anthropic", "claude-opus-5-5");
  assert.deepStrictEqual(opus, { choices: ["default", "low", "medium", "high", "xhigh", "max"], known: true });
  assert.deepStrictEqual(effortView("anthropic", "claude-opus-5-5", { id: "claude-opus-5-5", efforts: ["low", "high"] }).choices, ["default", "low", "high"], "the provider's list wins");
  assert.deepStrictEqual(effortView("anthropic", "claude-sonnet-5", { id: "claude-opus-5-5", efforts: ["low"] }).choices.length, 6, "info for another id is ignored");
  const old = effortView("openai", "gpt-4o");
  assert.deepStrictEqual(old.choices, ["default"]);
  assert.strictEqual(effortNote(old, "gpt-4o", "default"), "gpt-4o does not take a thinking level.");
  const unknown = effortView("openai", "llama3");
  assert.strictEqual(unknown.known, false);
  assert.ok(effortNote(unknown, "llama3", "default").includes("Test Connection"));
  assert.ok(effortNote(opus, "", "default").includes("Choose a model"));
  assert.ok(effortNote(opus, "claude-opus-5-5", "default").includes("nothing is sent"));
  assert.ok(effortNote(opus, "claude-opus-5-5", "max").includes("slower"));
  assert.strictEqual(fitEffort("max", opus), "max");
  assert.strictEqual(fitEffort("max", effortView("anthropic", "claude-opus-4-5")), "default", "a level the new model does not take goes back to Default");
  console.log("ok - the thinking levels follow the model, and say when the provider does not tell");
}

{
  const a = row({ id: "a", label: "Opus", effort: "high" });
  assert.deepStrictEqual(profileFacts(a), ["claude-opus-5-5", "Anthropic", "api.anthropic.com", "Thinking: High", "Key stored"], "a name of its own: the model is said");
  assert.deepStrictEqual(profileFacts(row({ id: "g", label: "Anthropic · claude-opus-5-5" })), ["Anthropic", "api.anthropic.com", "Thinking: Default", "Key stored"]);
  assert.strictEqual(profileFacts(row({ id: "b", label: "b claude-opus-5-5", key: { stored: false } }))[3], "No key");
  assert.strictEqual(profileFacts(row({ id: "c", label: "c claude-opus-5-5", key: { stored: true, origin: "https://other.example.com" } }))[3], "Key entered for another address");
  const b = row({ id: "b", label: "Llama", key: { stored: false } });
  const lone = removalText(a, [a], "a");
  assert.strictEqual(lone.question, "Remove the AI profile “Opus”?");
  assert.deepStrictEqual(lone.details, ["Its API key is deleted from VS Code's secret storage.", "No profile is left: the AI features wait until you add one."]);
  assert.deepStrictEqual(removalText(a, [a, b], "a").details[1], "Linyra AI will use “Llama” instead.");
  assert.deepStrictEqual(removalText(b, [a, b], "a").details, ["It has no stored API key."], "removing one not in use changes nothing else");
  console.log("ok - a row says provider, address, level and key; Remove says what goes and what is used next");
}

{
  const d = { protocol: "anthropic" as const, baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", effort: "default" as const };
  const fail = (status: number, detail?: string): StepResult => {
    const e = httpError(status, detail);
    return { ok: false, kind: e.kind, message: e.message, status: e.http?.status, detail: e.http?.detail, html: e.http?.html };
  };
  const works = testReport({ keyed: true, list: { ok: true, ms: 120, count: 24 }, send: { ok: true, ms: 1234 } }, d);
  assert.deepStrictEqual(works, { ok: true, title: "The connection works.", lines: [
    { status: "ok", text: "Reached api.anthropic.com and the key was accepted (24 models)." },
    { status: "ok", text: "claude-opus-5-5 answered in 1.2 s." },
  ] });
  const level = testReport({ keyed: true, list: { ok: true, ms: 1, count: 1 }, send: { ok: true, ms: 80, answeredBy: "claude-sonnet-5-5" } }, { ...d, effort: "high" });
  assert.strictEqual(level.lines[1].text, "claude-opus-5-5 answered in 80 ms. The answer came from claude-sonnet-5-5. Thinking level High was accepted.");
  const badKey = testReport({ keyed: true, list: fail(401, "invalid x-api-key") }, d);
  assert.strictEqual(badKey.ok, false);
  assert.strictEqual(badKey.title, "The test failed.");
  assert.deepStrictEqual(badKey.lines[0], { status: "failed", text: "api.anthropic.com did not accept the API key (401).",
    next: "Check the key, or replace it with a new one from the provider's console.", detail: "The provider says: invalid x-api-key" });
  assert.deepStrictEqual(badKey.lines[1], { status: "skipped", text: "claude-opus-5-5 was not tried: the step above has to work first." });
  assert.strictEqual(testReport({ keyed: false, list: fail(401) }, d).lines[0].next, "This server needs an API key: enter it above.");
  const noList = testReport({ keyed: true, list: fail(404), send: { ok: true, ms: 300 } }, { ...d, protocol: "openai", baseUrl: "https://gw.example.com/v1" });
  assert.strictEqual(noList.ok, true, "a gateway without a model list still works");
  assert.deepStrictEqual(noList.lines[0], { status: "warning", text: "gw.example.com does not list its models: type the model id." });
  const wrongModel = testReport({ keyed: true, list: { ok: true, ms: 1, count: 3 }, send: fail(404) }, { ...d, protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "nope" });
  assert.deepStrictEqual(wrongModel.lines.map((l) => l.status), ["ok", "failed"], "what worked, then what failed");
  assert.ok(wrongModel.lines[1].next?.includes("/v1"));
  const level400 = testReport({ keyed: true, list: { ok: true, ms: 1, count: 3 }, send: fail(400) }, { ...d, effort: "max" });
  assert.strictEqual(level400.lines[1].next, "claude-opus-5-5 may not take the thinking level Max: try Default.");
  assert.strictEqual(testReport({ keyed: true, list: { ok: true, ms: 1, count: 3 }, send: fail(400) }, d).lines[1].next, "Check the model id.");
  assert.ok(testReport({ keyed: true, list: fail(429) }, d).lines[0].next?.includes("quota"));
  assert.ok(testReport({ keyed: true, list: fail(403) }, d).lines[0].text.includes("403"));
  assert.ok(testReport({ keyed: true, list: fail(503) }, d).lines[0].text.includes("Try again later"));
  assert.ok(testReport({ keyed: true, list: fail(504) }, d).lines[0].text.includes("timed out"));
  const network = testReport({ keyed: true, list: { ok: false, kind: "network", message: "Could not connect to localhost:11434: nothing is listening there. Is the server running?" } }, d);
  assert.strictEqual(network.lines[0].text, "Could not connect to localhost:11434: nothing is listening there. Is the server running?", "the network sentence already says what to do");
  const page = fail(403);
  assert.ok(testReport({ keyed: true, list: { ...page, html: true } as StepResult }, d).lines[0].next?.includes("web page"));
  assert.deepStrictEqual(testReport({ keyed: true, list: { ok: true, ms: 1, count: 2 }, send: { ok: false, kind: "cancelled", message: "Cancelled." } }, d), { ok: false, title: "Test stopped.", lines: [] });
  assert.strictEqual(testReport({ keyed: true, list: { ok: true, ms: 1, count: 0 }, send: { ok: true, ms: 1, refused: true } }, d).lines[1].text,
    "claude-opus-5-5 answered in 1 ms, declining the test prompt: the connection works.");
  assert.strictEqual(duration(999), "999 ms");
  assert.strictEqual(duration(61_250), "61.3 s");
  console.log("ok - Test Connection reports each step in plain words: what worked, what failed and what to do next");
}

{
  assert.deepStrictEqual(checkDraft({ protocol: "openai", baseUrl: "http://localhost:11434/v1/", model: " llama3 ", effort: "turbo", label: "" }),
    { draft: { id: undefined, protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "llama3", effort: "default", label: "" } });
  for (const bad of [null, "x", { protocol: "nope", baseUrl: "https://a.example.com", model: "m" }, { protocol: "openai", baseUrl: 1, model: "m" },
    { id: "", protocol: "openai", baseUrl: "https://a.example.com", model: "m" }, { id: 5, protocol: "openai", baseUrl: "https://a.example.com", model: "m" }]) {
    assert.ok("error" in checkDraft(bad), JSON.stringify(bad));
  }
  assert.ok("error" in checkDraft({ protocol: "openai", baseUrl: "ftp://a.example.com", model: "m" }));
  assert.ok("error" in checkDraft({ protocol: "openai", baseUrl: "https://a.example.com", model: "" }));
  assert.ok("draft" in checkDraft({ protocol: "openai", baseUrl: "https://a.example.com", model: "" }, { model: false }), "the model list needs no model");
  assert.ok("error" in checkDraft({ protocol: "openai", baseUrl: "https://a.example.com", model: "m", label: "x".repeat(200) }));
  assert.deepStrictEqual(checkKeyChoice({ kind: "new", value: " sk-fake " }), { kind: "new", value: "sk-fake" });
  for (const bad of [undefined, { kind: "new", value: "" }, { kind: "new", value: "密钥" }, { kind: "from" }, { kind: "steal" }, { kind: "new", value: "x".repeat(9000) }]) {
    assert.strictEqual(checkKeyChoice(bad), undefined, JSON.stringify(bad));
  }
  assert.deepStrictEqual(checkKeyChoice({ kind: "keep" }), { kind: "keep" });
  assert.deepStrictEqual(checkKeyChoice({ kind: "from", profileId: "ai-1" }), { kind: "from", profileId: "ai-1" });
  const checked = checkDraft({ protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", effort: "high", label: "" });
  assert.ok("draft" in checked);
  assert.deepStrictEqual(profileOf(checked.draft, "ai-x"), { id: "ai-x", protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", effort: "high", label: "Anthropic · claude-opus-5-5" });
  assert.strictEqual(activeAfterSave("new", true, "old"), "new");
  assert.strictEqual(activeAfterSave("new", false, "old"), "old");
  assert.strictEqual(activeAfterSave("new", false, undefined), undefined);
  console.log("ok - the host checks every draft and key choice from the webview again");
}

{
  // Every sentence the page shows has its Chinese.
  const zh = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "l10n", "bundle.l10n.zh-cn.json"), "utf8")) as Record<string, string>;
  configureI18n("zh-cn", zh);
  const report = testReport({ keyed: true, list: { ok: true, ms: 1, count: 2 }, send: { ok: true, ms: 1500 } }, { protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "m", effort: "default" });
  assert.ok(!/[a-z]{4,} [a-z]{4,}/.test(report.title + report.lines.map((l) => l.text).join("")), report.title);
  configureI18n("en");
  console.log("ok - the report reads in Chinese");
}
