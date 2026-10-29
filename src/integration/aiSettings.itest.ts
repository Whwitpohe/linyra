// The Linyra AI page in real VS Code: Configure AI…, Switch AI Model… and Remove AI Profile… open it;
// Save writes linyra.ai.* and the key to SecretStorage (checked through a seam that compares the
// key, never returns it); the model list and Test Connection go to a local OpenAI-compatible server
// that takes one fake key. Puts the settings back (it runs after the ordered suites, see index.ts).
import * as assert from "assert";
import * as http from "http";
import type { AddressInfo } from "net";
import * as vscode from "vscode";
import type { AiSettingsHostMessage, AiSettingsState, TestOutcome } from "../ai/settingsProtocol";
import { waitFor } from "./helpers";

interface PageSnapshot { open: boolean; ready: boolean; visible: boolean; title: string | undefined; posted: AiSettingsHostMessage[] }

const KEY = "sk-itest-fake-key";

describe("Linyra AI page", () => {
  let server: http.Server;
  let base = "";
  const requests: { url: string; auth: string | undefined }[] = [];
  const page = () => vscode.commands.executeCommand<PageSnapshot>("linyra._itest.aiSettings");
  const tell = (m: unknown) => vscode.commands.executeCommand("linyra._itest.aiSettingsSend", m);
  const keyIs = (id: string, expected: string | undefined) => vscode.commands.executeCommand<{ stored: boolean; origin?: string; matches: boolean }>("linyra._itest.aiKeyIs", id, expected);
  const config = () => vscode.workspace.getConfiguration("linyra.ai");
  /** The last message of this type the page was sent (and that passes `ok`), once there is one. */
  const last = <T extends AiSettingsHostMessage["type"]>(type: T, ok: (m: Extract<AiSettingsHostMessage, { type: T }>) => boolean = () => true) =>
    waitFor(`the page's last ${type}`, async () => ((await page()).posted.filter((m) => m.type === type) as Extract<AiSettingsHostMessage, { type: T }>[]).filter(ok).at(-1));
  const stateNow = async () => (await page()).posted.filter((m): m is AiSettingsState => m.type === "state").at(-1)!;
  const draft = (over: Record<string, unknown> = {}) => ({ protocol: "openai", baseUrl: `${base}/v1`, model: "acme-coder", effort: "default", label: "", ...over });

  before(async () => {
    server = http.createServer((req, res) => {
      requests.push({ url: req.url ?? "", auth: req.headers.authorization });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { message: "Incorrect API key provided." } });
      if (req.method === "GET" && req.url === "/v1/models") return json(200, { data: [{ id: "acme-coder", context_length: 32768 }, { id: "acme-chat" }] });
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        req.resume();
        req.on("end", () => json(200, { id: "c1", object: "chat.completion", model: "acme-coder", choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }));
        return;
      }
      json(404, { error: { message: "not here" } });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    for (const p of (await stateNow())?.profiles ?? []) await tell({ type: "remove", id: p.id });
    for (const key of ["profiles", "activeProfile", "enabled"]) await config().update(key, undefined, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("Configure AI… opens one editor tab on the add form while there is no profile", async () => {
    await vscode.commands.executeCommand("linyra.ai.configure");
    const shown = await waitFor("the page ready", async () => { const p = await page(); return p.open && p.ready ? p : undefined; });
    assert.strictEqual(shown.title, "Linyra AI");
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith("linyra.aiSettings"), "an editor tab, not a popup");
    assert.deepStrictEqual(await last("open"), { type: "open", view: "add" });
    const state = await stateNow();
    assert.deepStrictEqual([state.profiles, state.enabled], [[], false]);
    await vscode.commands.executeCommand("linyra.ai.configure");
    assert.strictEqual(vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.label === "Linyra AI").length, 1, "one page, brought forward");
  });

  it("reads the model list of a local server with the key typed in the form", async () => {
    await tell({ type: "models", seq: 1, draft: draft({ model: "" }), key: { kind: "new", value: KEY } });
    const models = await last("models", (m) => m.seq === 1);
    assert.deepStrictEqual(models.models?.map((m) => m.id), ["acme-chat", "acme-coder"]);
    await tell({ type: "models", seq: 2, draft: draft(), key: { kind: "none" } });
    assert.match((await last("models", (m) => m.seq === 2)).error ?? "", /401/);
  });

  it("Save writes the profile to the settings and the key to SecretStorage, and turns AI on", async () => {
    await tell({ type: "save", draft: draft({ label: "Coder" }), key: { kind: "new", value: KEY }, use: true });
    const done = await last("done", (m) => m.action === "save");
    assert.ok(done.id && !done.error, done.error);
    const id = done.id!;
    assert.deepStrictEqual(config().get("profiles"), [{ id, label: "Coder", protocol: "openai", baseUrl: `${base}/v1`, model: "acme-coder", effort: "default" }]);
    assert.strictEqual(config().get("activeProfile"), id);
    assert.strictEqual(config().get("enabled"), true);
    assert.deepStrictEqual(await keyIs(id, KEY), { stored: true, origin: base, matches: true });
    const state = await stateNow();
    assert.deepStrictEqual(state.profiles.map((p) => [p.id, p.key]), [[id, { stored: true, origin: base }]], "the page learns only that a key is stored, and where");
    assert.ok(!JSON.stringify((await page()).posted).includes(KEY), "no message to the page carries the key");
    assert.strictEqual(state.activeId, id);
  });

  it("Test Connection: the stored key lists the models and the model answers; a wrong key stops at the first step", async () => {
    const id = (await stateNow()).activeId!;
    await tell({ type: "test", seq: 3, draft: draft({ id }), key: { kind: "keep" } });
    const ok: TestOutcome = (await last("tested", (m) => m.seq === 3)).outcome;
    assert.deepStrictEqual([ok.keyed, ok.list.ok, ok.list.ok && ok.list.count, ok.send?.ok, ok.send?.ok && ok.send.answeredBy], [true, true, 2, true, "acme-coder"]);
    assert.ok(requests.some((r) => r.url === "/v1/chat/completions" && r.auth === `Bearer ${KEY}`));
    await tell({ type: "test", seq: 4, draft: draft({ id }), key: { kind: "new", value: "sk-wrong-fake" } });
    const bad = (await last("tested", (m) => m.seq === 4)).outcome;
    assert.deepStrictEqual([bad.list.ok, !bad.list.ok && bad.list.status, !bad.list.ok && bad.list.detail, bad.send], [false, 401, "Incorrect API key provided.", undefined]);
    // The stored key is sent only to the origin it was entered for.
    await tell({ type: "test", seq: 5, draft: draft({ id, baseUrl: "http://localhost:9/v1" }), key: { kind: "keep" } });
    const elsewhere = (await last("tested", (m) => m.seq === 5)).outcome;
    assert.ok(!elsewhere.list.ok && elsewhere.list.kind === "auth" && /never sent/.test(elsewhere.list.message), JSON.stringify(elsewhere));
  });

  it("Switch AI Model… focuses the list; Use switches the profile in use", async () => {
    const first = (await stateNow()).activeId!;
    await tell({ type: "save", draft: draft({ model: "acme-chat" }), key: { kind: "from", profileId: first }, use: false });
    const second = (await last("done", (m) => m.action === "save" && m.id !== first)).id!;
    assert.strictEqual(config().get("activeProfile"), first, "a profile saved without Use leaves the one in use");
    assert.deepStrictEqual(await keyIs(second, KEY), { stored: true, origin: base, matches: true }, "the key of the same address was copied, host-side");
    await vscode.commands.executeCommand("linyra.ai.switchModel");
    assert.deepStrictEqual(await last("open", (m) => m.view === "list"), { type: "open", view: "list", focus: "active" });
    await tell({ type: "use", id: second });
    await last("done", (m) => m.action === "use");
    assert.strictEqual(config().get("activeProfile"), second);
  });

  it("Remove AI Profile… focuses the list; Remove deletes the profile and its key, and the next one is used", async () => {
    const before = await stateNow();
    const [first, second] = before.profiles.map((p) => p.id);
    await vscode.commands.executeCommand("linyra.ai.removeProfile");
    assert.deepStrictEqual(await last("open", (m) => m.view === "list" && m.focus === "first"), { type: "open", view: "list", focus: "first" });
    await tell({ type: "remove", id: second });
    await last("done", (m) => m.action === "remove");
    assert.deepStrictEqual((config().get<{ id: string }[]>("profiles") ?? []).map((p) => p.id), [first]);
    assert.strictEqual(config().get("activeProfile"), first);
    assert.deepStrictEqual(await keyIs(second, KEY), { stored: false, origin: undefined, matches: false });
    assert.deepStrictEqual(await keyIs(first, KEY), { stored: true, origin: base, matches: true }, "the other profile's copy stays");
  });

  it("refuses what the webview cannot send: a bad address, a key from another provider's profile", async () => {
    await tell({ type: "save", draft: draft({ baseUrl: "ftp://files.example.com" }), key: { kind: "none" }, use: false });
    assert.match((await last("done", (m) => m.action === "save" && !!m.error)).error ?? "", /https/);
    const first = (await stateNow()).profiles[0].id;
    await tell({ type: "test", seq: 6, draft: draft({ protocol: "anthropic" }), key: { kind: "from", profileId: first } });
    const outcome = (await last("tested", (m) => m.seq === 6)).outcome;
    assert.ok(!outcome.list.ok && outcome.list.kind === "auth", JSON.stringify(outcome));
    assert.strictEqual((config().get<unknown[]>("profiles") ?? []).length, 1);
  });

  it("the switch turns AI off and on; the page closes like any editor tab", async () => {
    await tell({ type: "enable", on: false });
    await last("done", (m) => m.action === "enable" && m.note?.includes("off") === true);
    assert.strictEqual(config().get("enabled"), false);
    await tell({ type: "enable", on: true });
    await waitFor("AI on", () => (config().get("enabled") === true ? true : undefined));
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    await waitFor("the page closed", async () => ((await page()).open ? undefined : true));
  });
});
