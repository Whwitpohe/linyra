// The Linyra AI page: one editor tab that lists the AI profiles and adds, edits, tests, uses and
// removes them (Configure AI…, Switch AI Model…, Remove AI Profile…). Thin: the decisions are in
// settingsModel.ts. No key ever reaches the webview: a profile says only whether one is stored,
// and for which origin. Every message from the webview is checked again here.
import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { localize } from "../i18n";
import { outputLog } from "../outputLog";
import { renderAiSettingsHtml } from "../webview/aiSettings/html";
import { asAiError } from "./errors";
import { activeAfterRemoval, newProfileId, originOf, upsertProfile } from "./profileModel";
import { activeAfterSave, checkDraft, checkKeyChoice, profileOf, redactKey } from "./settingsModel";
import type { AiSettingsHostMessage, AiSettingsState, AiSettingsView, DraftProfile, KeyChoice, StepResult } from "./settingsProtocol";
import { readAiSettings, writeAiSettings, type AiKeys } from "./store";
import { AiError, type AiProtocol, type AiProvider } from "./types";

export interface AiSettingsDeps {
  extensionUri: vscode.Uri;
  providers: Readonly<Record<AiProtocol, AiProvider>>;
  keys: AiKeys;
}

/** What the integration tests read: the page, and every message it was sent (never a key). */
export interface AiSettingsSnapshot { open: boolean; ready: boolean; visible: boolean; title: string | undefined; posted: AiSettingsHostMessage[] }

const POSTED_KEPT = 200;
/** A feature waiting for AI to be set up gives up after this long: it never runs much later, unasked. */
const WAIT_MS = 10 * 60_000;
/** The messages to the page, kept for the integration suite only. */
const KEEP_POSTED = process.env.LINYRA_ITEST === "1";

/** A failed step for the page: its kind, status and words, never with the key in them (some gateways echo it). */
function stepFailure(error: AiError, key: string | undefined): Extract<StepResult, { ok: false }> {
  return { ok: false, kind: error.kind, message: redactKey(error.message, key), status: error.http?.status, detail: redactKey(error.http?.detail, key), html: error.http?.html };
}

export class AiSettingsPage implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  /** The webview said ready: it takes messages. */
  private ready = false;
  /** The view to open once the webview is ready. */
  private pending: AiSettingsView | undefined;
  private models: AbortController | undefined;
  private test: AbortController | undefined;
  /** ensureReady() callers waiting for a profile in use (true), or for the page to close or be left (false). */
  private readonly waiting = new Set<(closed: boolean) => void>();
  private readonly posted: AiSettingsHostMessage[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly deps: AiSettingsDeps) {
    this.disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("linyra.ai")) return;
      if (this.ready) void this.postState();
      this.settle(false);
    }));
  }

  /** Opens the page on `view`, or brings it forward there. */
  open(view: AiSettingsView): void {
    if (this.panel) {
      this.panel.reveal();
      if (this.ready) this.post({ type: "open", ...view });
      else this.pending = view;
      return;
    }
    const out = vscode.Uri.joinPath(this.deps.extensionUri, "out");
    const panel = vscode.window.createWebviewPanel("linyra.aiSettings", localize("Linyra AI"), vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [out] });
    this.panel = panel;
    this.ready = false;
    this.pending = view;
    panel.iconPath = vscode.Uri.joinPath(this.deps.extensionUri, "media", "linyra.svg");
    const received = panel.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m));
    // Left for another tab: a feature that waited for the setup stops waiting (it is run again when wanted).
    const viewed = panel.onDidChangeViewState(() => { if (!panel.visible) this.settle(true); });
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.ready = false;
      this.models?.abort();
      this.test?.abort();
      received.dispose();
      viewed.dispose();
      this.settle(true);
    });
    panel.webview.html = renderAiSettingsHtml({ cspSource: panel.webview.cspSource, nonce: randomBytes(16).toString("hex"),
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(out, "aiSettings.js")).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(out, "aiSettings.css")).toString() });
  }

  /**
   * True once `ready()` holds (a profile in use, AI on) while the page is in front; false when the
   * page closes, is left for another tab, or after ten minutes, so a request never goes out much
   * later, unasked.
   */
  untilReady(ready: () => boolean, waitMs = WAIT_MS): Promise<boolean> {
    if (ready()) return Promise.resolve(true);
    if (!this.panel) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => check(true), waitMs);
      const check = (stop: boolean) => {
        if (!ready() && !stop) return;
        clearTimeout(timer);
        this.waiting.delete(check);
        resolve(ready());
      };
      this.waiting.add(check);
    });
  }

  private settle(stop: boolean): void {
    for (const check of [...this.waiting]) check(stop);
  }

  snapshot(): AiSettingsSnapshot {
    return { open: !!this.panel, ready: this.ready, visible: this.panel?.visible ?? false, title: this.panel?.title, posted: [...this.posted] };
  }

  async onMessage(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") return;
    const m = raw as { type?: unknown; [key: string]: unknown };
    const seq = typeof m.seq === "number" ? m.seq : 0;
    switch (m.type) {
      case "ready":
        this.ready = true;
        await this.postState();
        if (this.pending) this.post({ type: "open", ...this.pending });
        this.pending = undefined;
        return;
      case "models": return this.loadModels(seq, m.draft, m.key);
      case "test": return this.runTest(seq, m.draft, m.key);
      case "stopTest": this.test?.abort(); return;
      case "save": return this.save(m.draft, m.key, m.use === true);
      case "use": return this.use(m.id);
      case "remove": return this.remove(m.id);
      case "enable": return this.enable(m.on === true);
      case "moreSettings": await vscode.commands.executeCommand("workbench.action.openSettings", "linyra.ai"); return;
    }
  }

  private post(m: AiSettingsHostMessage): void {
    if (KEEP_POSTED) {
      this.posted.push(m);
      if (this.posted.length > POSTED_KEPT) this.posted.shift();
    }
    void this.panel?.webview.postMessage(m);
  }

  private async state(): Promise<AiSettingsState> {
    const s = readAiSettings();
    const profiles = await Promise.all(s.profiles.map(async ({ id, label, protocol, baseUrl, model, effort }) => {
      const origin = await this.deps.keys.storedOrigin(id).catch(() => undefined);
      return { id, label, protocol, baseUrl, model, effort, key: origin ? { stored: true, origin } : { stored: false } };
    }));
    return { type: "state", enabled: s.enabled, activeId: s.active?.id, profiles };
  }

  private async postState(): Promise<void> {
    this.post(await this.state());
  }

  /** The key a request may send to the draft's address. Never one entered for another origin. */
  private async keyFor(draft: DraftProfile, choice: KeyChoice): Promise<string | undefined> {
    switch (choice.kind) {
      case "none": return undefined;
      case "new": return choice.value;
      case "keep": return draft.id === undefined ? undefined : this.storedKey(draft.id, draft.baseUrl);
      case "from": {
        const from = readAiSettings().profiles.find((p) => p.id === choice.profileId);
        if (!from || from.protocol !== draft.protocol) throw new AiError(localize("The key of that profile cannot be used here. Enter a key."), "auth");
        return this.storedKey(from.id, draft.baseUrl);
      }
    }
  }

  private async storedKey(profileId: string, baseUrl: string): Promise<string | undefined> {
    const saved = await this.deps.keys.saved(profileId);
    if (!saved) return undefined;
    if (saved.origin !== originOf(baseUrl)) {
      throw new AiError(localize("The stored key was entered for {0}, and it is never sent to {1}. Enter a key for this address.", saved.origin, originOf(baseUrl)), "auth");
    }
    return saved.key;
  }

  private async loadModels(seq: number, rawDraft: unknown, rawKey: unknown): Promise<void> {
    this.models?.abort();
    const controller = new AbortController();
    this.models = controller;
    const checked = checkDraft(rawDraft, { model: false });
    const choice = checkKeyChoice(rawKey);
    if ("error" in checked || !choice) {
      this.post({ type: "models", seq, failure: { ok: false, kind: "badRequest", message: "error" in checked ? checked.error : localize("The form arrived incomplete. Try again.") } });
      return;
    }
    const draft = checked.draft;
    let key: string | undefined;
    try {
      key = await this.keyFor(draft, choice);
      const models = await this.deps.providers[draft.protocol].listModels(profileOf(draft, draft.id ?? "draft"), key, controller.signal);
      if (!controller.signal.aborted) this.post({ type: "models", seq, models: models.slice(0, 5000) });
    } catch (e) {
      if (!controller.signal.aborted) this.post({ type: "models", seq, failure: stepFailure(asAiError(e, controller.signal, draft.baseUrl), key) });
    } finally {
      if (this.models === controller) this.models = undefined;
    }
  }

  /** Test Connection: the model list (address and key), then one tiny request (model and thinking level). */
  private async runTest(seq: number, rawDraft: unknown, rawKey: unknown): Promise<void> {
    this.test?.abort();
    const controller = new AbortController();
    this.test = controller;
    let key: string | undefined;
    const failed = (e: unknown): StepResult => stepFailure(asAiError(e, controller.signal, typeof (rawDraft as { baseUrl?: unknown })?.baseUrl === "string" ? (rawDraft as { baseUrl: string }).baseUrl : undefined), key);
    const checked = checkDraft(rawDraft);
    const choice = checkKeyChoice(rawKey);
    if ("error" in checked || !choice) {
      this.post({ type: "tested", seq, outcome: { keyed: false, list: failed(new AiError("error" in checked ? checked.error : localize("The form arrived incomplete. Try again."), "badRequest")) } });
      return;
    }
    const draft = checked.draft;
    const profile = profileOf(draft, draft.id ?? "draft");
    const provider = this.deps.providers[draft.protocol];
    const step = async (run: () => Promise<{ count?: number; answeredBy?: string; refused?: boolean }>): Promise<StepResult> => {
      const started = Date.now();
      try {
        const answer = await run();
        return { ok: true, ms: Date.now() - started, ...answer };
      } catch (e) {
        return failed(e);
      }
    };
    try {
      key = await this.keyFor(draft, choice);
    } catch (e) {
      this.post({ type: "tested", seq, outcome: { keyed: false, list: failed(e) } });
      return;
    }
    this.post({ type: "testStep", seq, step: 1 });
    const list = await step(async () => ({ count: (await provider.listModels(profile, key, controller.signal)).length }));
    // A key refused, or no answer at all: the request would fail the same way. Anything else (a gateway without /models) goes on.
    const stop = !list.ok && (list.status === 401 || list.kind === "network" || list.kind === "cancelled");
    let send: StepResult | undefined;
    if (!stop) {
      this.post({ type: "testStep", seq, step: 2 });
      send = await step(async () => {
        const r = await provider.send(profile, key, { system: "", turns: [{ role: "user", content: "Reply with the word OK." }], signal: controller.signal });
        return { answeredBy: r.model, refused: r.stop === "refusal" };
      });
    }
    if (this.test === controller) this.test = undefined;
    const said = (r: StepResult | undefined) => (r === undefined ? "skipped" : r.ok ? `ok ${r.ms} ms` : `${r.kind}${r.status ? ` ${r.status}` : ""}`);
    outputLog().info(`AI test ${draft.protocol} ${draft.model}: models ${said(list)}, request ${said(send)}`);
    this.post({ type: "tested", seq, outcome: { keyed: key !== undefined, list, send } });
  }

  private async save(rawDraft: unknown, rawKey: unknown, use: boolean): Promise<void> {
    const checked = checkDraft(rawDraft);
    const choice = checkKeyChoice(rawKey);
    if ("error" in checked || !choice) {
      this.post({ type: "done", action: "save", error: "error" in checked ? checked.error : localize("The form arrived incomplete. Try again.") });
      return;
    }
    const draft = checked.draft;
    try {
      const id = draft.id ?? newProfileId(readAiSettings().profiles.map((p) => p.id));
      // The key first: a profile is never saved pointing at a key that is not there.
      switch (choice.kind) {
        case "keep": await this.storedKey(id, draft.baseUrl); break;
        case "new": await this.deps.keys.set(id, choice.value, draft.baseUrl); break;
        case "from": await this.deps.keys.set(id, await this.keyFor(draft, choice), draft.baseUrl); break;
        case "none": await this.deps.keys.delete(id); break;
      }
      const profile = profileOf(draft, id);
      const fresh = readAiSettings();
      await writeAiSettings(upsertProfile(fresh.profiles, profile), activeAfterSave(id, use, fresh.active?.id), use ? true : undefined);
      await this.postState();
      this.post({ type: "done", action: "save", id, note: use ? localize("Saved. Linyra AI now uses {0}.", profile.label) : localize("Saved “{0}”.", profile.label) });
    } catch (e) {
      await this.postState();
      this.post({ type: "done", action: "save", error: redactKey(asAiError(e).message, choice.kind === "new" ? choice.value : undefined) });
    }
  }

  private async use(id: unknown): Promise<void> {
    const s = readAiSettings();
    const profile = s.profiles.find((p) => p.id === id);
    if (!profile) return this.gone("use");
    try {
      await writeAiSettings(s.profiles, profile.id, true);
      await this.postState();
      this.post({ type: "done", action: "use", id: profile.id, note: localize("Linyra AI now uses {0}.", profile.label) });
    } catch (e) {
      await this.postState();
      this.post({ type: "done", action: "use", error: asAiError(e).message });
    }
  }

  private async remove(id: unknown): Promise<void> {
    const profile = readAiSettings().profiles.find((p) => p.id === id);
    if (!profile) return this.gone("remove");
    try {
      await this.deps.keys.delete(profile.id);
      const fresh = readAiSettings();
      await writeAiSettings(fresh.profiles.filter((p) => p.id !== profile.id), activeAfterRemoval(fresh.profiles, fresh.active?.id, [profile.id]));
      await this.postState();
      this.post({ type: "done", action: "remove", id: profile.id, note: localize("Removed “{0}”.", profile.label) });
    } catch (e) {
      await this.postState();
      this.post({ type: "done", action: "remove", error: asAiError(e).message });
    }
  }

  private async enable(on: boolean): Promise<void> {
    const s = readAiSettings();
    try {
      // Turned on with no profile chosen: the first one, as the only profile would be.
      if (on && !s.active && s.profiles.length > 0) await writeAiSettings(s.profiles, s.profiles[0].id, true);
      else await vscode.workspace.getConfiguration("linyra.ai").update("enabled", on, vscode.ConfigurationTarget.Global);
      await this.postState();
      this.post({ type: "done", action: "enable", note: on ? localize("Linyra AI is on.") : localize("Linyra AI is off: nothing is sent to any AI provider.") });
    } catch (e) {
      // The switch shows what the settings say, not what was clicked.
      await this.postState();
      this.post({ type: "done", action: "enable", error: asAiError(e).message });
    }
  }

  private async gone(action: "use" | "remove"): Promise<void> {
    await this.postState();
    this.post({ type: "done", action, error: localize("That profile no longer exists.") });
  }

  dispose(): void {
    this.settle(true);
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
