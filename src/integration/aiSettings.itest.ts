// The Linyra AI page in real VS Code: Configure AI…, Switch AI Model… and Remove AI Profile… open it;
// Save writes linyra.ai.* and the key to SecretStorage (checked through a seam that compares the
// key, never returns it); the model list and Test Connection go to a local OpenAI-compatible server
// that takes one fake key. Puts the settings back (it runs after the ordered suites, see index.ts).
import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import * as vscode from "vscode";
import type { AiSettingsHostMessage, AiSettingsState, TestOutcome } from "../ai/settingsProtocol";
import { ALL, send, snapshot, until, waitFor } from "./helpers";

interface PageSnapshot { open: boolean; ready: boolean; visible: boolean; title: string | undefined; posted: AiSettingsHostMessage[] }

const KEY = "sk-itest-fake-key";

describe("Linyra AI page", () => {
  let server: http.Server;
  let base = "";
  const requests: { url: string; auth: string | undefined }[] = [];
  /** Every chat request's body, as the server received it. */
  const prompts: string[] = [];
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
    await vscode.commands.executeCommand("linyra.open");
    await until("the Log webview", (st) => st.readyCount >= 1 && st.repos.length === 3);
    server = http.createServer((req, res) => {
      requests.push({ url: req.url ?? "", auth: req.headers.authorization });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      // A gateway that echoes the key it was given: the page must never see it.
      if (req.headers.authorization?.startsWith("Bearer sk-echo")) return json(401, { error: { message: `Invalid API key: ${req.headers.authorization.slice(7)}` } });
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { message: "Incorrect API key provided." } });
      if (req.method === "GET" && req.url === "/v1/models") return json(200, { data: [{ id: "acme-coder", context_length: 32768 }, { id: "acme-chat" }] });
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        req.on("end", () => {
          prompts.push(body);
          const merging = /`ai-(one|two)\.go`/.exec(body)?.[1];
          const content = body.includes("You name git stashes") ? "WIP: tidy the notes"
            : merging ? `\`\`\`merged\npackage upload\n\nconst ${merging === "one" ? "One" : "Two"} = "both"\n\`\`\`\nNote: kept both sides.`
            : "OK";
          json(200, { id: "c1", object: "chat.completion", model: "acme-coder", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
        });
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
    const refused = (await last("models", (m) => m.seq === 2)).failure;
    assert.deepStrictEqual([refused?.kind, refused?.status, refused?.detail], ["auth", 401, "Incorrect API key provided."], "the page words it from the status");
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
    // A gateway that echoes the key: what reaches the page has it cut out.
    const echoed = "sk-echo-fake-0123456789";
    await tell({ type: "test", seq: 7, draft: draft({ id }), key: { kind: "new", value: echoed } });
    const cut = (await last("tested", (m) => m.seq === 7)).outcome;
    assert.ok(!cut.list.ok && cut.list.detail === "Invalid API key: …", JSON.stringify(cut));
    await tell({ type: "models", seq: 8, draft: draft({ id }), key: { kind: "new", value: echoed } });
    await last("models", (m) => m.seq === 8);
    assert.ok(!JSON.stringify((await page()).posted).includes(echoed), "no message to the page carries an echoed key");
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
    // SecretStorage may answer from its cache for a moment after a delete: the key has to go, not at once.
    await waitFor("the removed profile's key deleted", async () => ((await keyIs(second, KEY)).stored ? undefined : true));
    assert.deepStrictEqual(await keyIs(first, KEY), { stored: true, origin: base, matches: true }, "the other profile's copy stays");
  });

  it("refuses what the webview cannot send: a bad address, another provider's key, a key for another origin", async () => {
    await tell({ type: "save", draft: draft({ baseUrl: "ftp://files.example.com" }), key: { kind: "none" }, use: false });
    assert.match((await last("done", (m) => m.action === "save" && !!m.error)).error ?? "", /https/);
    const first = (await stateNow()).profiles[0].id;
    await tell({ type: "test", seq: 6, draft: draft({ protocol: "anthropic" }), key: { kind: "from", profileId: first } });
    const outcome = (await last("tested", (m) => m.seq === 6)).outcome;
    assert.ok(!outcome.list.ok && outcome.list.kind === "auth", JSON.stringify(outcome));
    // The same provider at another origin (the same server as localhost): the copied key is refused before any request.
    const sent = requests.length;
    const other = base.replace("127.0.0.1", "localhost");
    await tell({ type: "test", seq: 9, draft: draft({ baseUrl: `${other}/v1` }), key: { kind: "from", profileId: first } });
    const moved = (await last("tested", (m) => m.seq === 9)).outcome;
    assert.ok(!moved.list.ok && moved.list.kind === "auth" && /never sent/.test(moved.list.message), JSON.stringify(moved));
    await tell({ type: "save", draft: draft({ baseUrl: `${other}/v1` }), key: { kind: "from", profileId: first }, use: false });
    assert.match((await last("done", (m) => m.action === "save" && /never sent/.test(m.error ?? ""))).error ?? "", /never sent/);
    assert.strictEqual(requests.length, sent, "nothing reached the other origin");
    assert.strictEqual((config().get<unknown[]>("profiles") ?? []).length, 1);
  });

  it("a feature waiting for the setup goes on once AI is ready, and stops when the page is left or after its time", async () => {
    const wait = (ms?: number) => vscode.commands.executeCommand<boolean>("linyra._itest.aiWaitReady", ms);
    await tell({ type: "enable", on: false });
    await waitFor("AI off", () => (config().get("enabled") === false ? true : undefined));
    const ready = wait();
    await waitFor("the page in front", async () => ((await page()).visible ? true : undefined));
    await tell({ type: "enable", on: true });
    assert.strictEqual(await ready, true, "turned on: the feature goes on");
    await tell({ type: "enable", on: false });
    await waitFor("AI off", () => (config().get("enabled") === false ? true : undefined));
    const left = wait();
    await waitFor("the page in front", async () => ((await page()).visible ? true : undefined));
    const doc = await vscode.workspace.openTextDocument({ content: "another tab" });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active });
    assert.strictEqual(await left, false, "left for another tab: the feature stops waiting");
    assert.strictEqual(await wait(200), false, "and never waits more than its time");
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await tell({ type: "enable", on: true });
    await waitFor("AI on", () => (config().get("enabled") === true ? true : undefined));
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

  it("Stash Changes…'s ✨ (a box of its own) writes the message from the work, new files only when asked", async () => {
    await send({ type: "filter", filter: ALL });
    const web = (await snapshot()).repos.find((r) => r.name === "acme-web")!;
    const tracked = path.join(web.root, "client.ts");
    const original = fs.readFileSync(tracked, "utf8");
    const fresh = path.join(web.root, "ai-stash-new.md");
    const write = (untracked: boolean) => vscode.commands.executeCommand<{ text: string | undefined } | undefined>("linyra._itest.stashWrite", { repoId: web.id, untracked });
    try {
      fs.writeFileSync(tracked, `${original}export const aiStashTracked = 1;\n`);
      fs.writeFileSync(fresh, "ai-stash untracked note\n");
      await vscode.commands.executeCommand("linyra.refreshUncommitted");
      await waitFor("the new file in the uncommitted work", async () =>
        ((await vscode.commands.executeCommand<{ items: string[] }>("linyra._itest.uncommitted")).items.some((i) => i.includes("ai-stash-new.md")) ? true : undefined));
      assert.strictEqual((await write(false))?.text, "WIP: tidy the notes");
      assert.ok(prompts.at(-1)!.includes("aiStashTracked") && !prompts.at(-1)!.includes("ai-stash untracked note"), "a new file stays out unless asked");
      assert.strictEqual((await write(true))?.text, "WIP: tidy the notes");
      assert.ok(prompts.at(-1)!.includes("ai-stash untracked note"), "and goes in when asked");
    } finally {
      fs.writeFileSync(tracked, original);
      fs.rmSync(fresh, { force: true });
      await vscode.commands.executeCommand("linyra.refreshUncommitted");
    }
  });

  it("Resolve Conflicts with AI: one choice per file; Esc skips that file and the run goes on; Stop ends it", async () => {
    const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    const env = { ...process.env, GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: api.root, encoding: "utf8", env, stdio: ["pipe", "pipe", "pipe"] }).trim();
    const start = git("rev-parse", "HEAD");
    const branch = git("symbolic-ref", "--short", "HEAD");
    const answer = (v: string | undefined) => vscode.commands.executeCommand("linyra._itest.answer", v);
    const report = () => vscode.commands.executeCommand<string | undefined>("linyra._itest.conflictReport");
    const file = (name: string) => path.join(api.root, name);
    const commitBoth = (side: string) => {
      for (const n of ["one", "two"]) fs.writeFileSync(file(`ai-${n}.go`), `package upload\n\nconst ${n === "one" ? "One" : "Two"} = "${side}"\n`);
      git("add", "ai-one.go", "ai-two.go");
      git("commit", "-q", "-m", `ai conflict: ${side}`);
    };
    const merges = () => prompts.filter((p) => p.includes("You resolve git merge conflicts")).length;
    try {
      git("checkout", "-q", "-b", "ai-theirs");
      commitBoth("theirs");
      git("checkout", "-q", branch);
      commitBoth("ours");
      assert.throws(() => git("merge", "ai-theirs"), "the merge stops on conflicts");
      await vscode.commands.executeCommand("linyra.refreshUncommitted");
      await waitFor("the conflicted files", async () =>
        ((await vscode.commands.executeCommand<{ items: string[] }>("linyra._itest.uncommitted")).items.some((i) => i.includes("ai-two.go")) ? true : undefined));
      // Stop on the first file: the run ends there, the second is never sent.
      const before = merges();
      await answer("$(debug-stop) Stop");
      await vscode.commands.executeCommand("linyra.ai.resolveConflicts", { repoId: api.id });
      assert.strictEqual(merges() - before, 1, "only the first file was sent");
      assert.strictEqual(await report(), "Linyra AI: 0 of 2 conflicted files resolved and staged; stopped before the other 1. Continue the merge in Source Control once every file is resolved.");
      // Esc on the first skips it and the run goes on; the second is accepted in one step: written and staged.
      await answer("Escape");
      await answer("$(check) Accept and Stage");
      await vscode.commands.executeCommand("linyra.ai.resolveConflicts", { repoId: api.id });
      assert.strictEqual(await report(), "Linyra AI: 1 of 2 conflicted files resolved and staged. Continue the merge in Source Control once every file is resolved.");
      assert.deepStrictEqual(git("diff", "--name-only", "--diff-filter=U").split("\n"), ["ai-one.go"], "the skipped file is still conflicted");
      assert.match(fs.readFileSync(file("ai-one.go"), "utf8"), /^<<<<<<< /m);
      assert.strictEqual(fs.readFileSync(file("ai-two.go"), "utf8"), 'package upload\n\nconst Two = "both"\n');
      assert.ok(git("diff", "--cached", "--name-only").split("\n").includes("ai-two.go"), "and the accepted one is staged");
      assert.ok(!vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.label.includes("AI proposal")), "no proposal is left open");
    } finally {
      await answer(undefined);
      try { git("merge", "--abort"); } catch { /* not merging any more */ }
      git("checkout", "-q", branch);
      git("reset", "-q", "--hard", start);
      git("branch", "-D", "ai-theirs");
      for (const n of ["ai-one.go", "ai-two.go"]) fs.rmSync(file(n), { force: true });
      await vscode.commands.executeCommand("linyra.refreshUncommitted");
    }
  });
});
