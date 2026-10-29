// Linyra: Configure AI… (protocol → base URL → API key → models → thinking level → test),
// Switch AI Model… and Remove AI Profile…. Thin: the decisions are in profileModel.ts.
import * as vscode from "vscode";
import { localize } from "../i18n";
import { asAiError, hostOf } from "./errors";
import {
  activeAfterRemoval, checkBaseUrl, DEFAULT_BASE_URL, DEFAULT_MODEL, effortChoices, effortLabel, isLocalUrl, isPlainRemote, knownEfforts, newProfileId,
  originOf, profileLabel, protocolName, PROTOCOLS, sameConnection, upsertProfile, withModel,
} from "./profileModel";
import { readAiSettings, writeAiSettings, type AiKeys } from "./store";
import type { AiEffort, AiError, AiModel, AiProfile, AiProtocol, AiProvider } from "./types";

const BACK = Symbol("back");
type Step<T> = T | typeof BACK | undefined;

interface InputOptions {
  title: string;
  step: number;
  total: number;
  value: string;
  prompt: string;
  placeholder?: string;
  password?: boolean;
  validate?(value: string): vscode.InputBoxValidationMessage | undefined;
}

function input(o: InputOptions): Promise<Step<string>> {
  return new Promise((resolve) => {
    const box = vscode.window.createInputBox();
    Object.assign(box, { title: o.title, step: o.step, totalSteps: o.total, value: o.value, prompt: o.prompt, placeholder: o.placeholder, password: !!o.password, ignoreFocusOut: true });
    box.buttons = o.step > 1 ? [vscode.QuickInputButtons.Back] : [];
    let done = false;
    const finish = (value: Step<string>) => {
      if (done) return;
      done = true;
      resolve(value);
      box.dispose();
    };
    const check = () => { box.validationMessage = o.validate?.(box.value); };
    box.onDidChangeValue(check);
    box.onDidAccept(() => {
      const message = o.validate?.(box.value);
      if (message?.severity === vscode.InputBoxValidationSeverity.Error) return;
      finish(box.value);
    });
    box.onDidTriggerButton((b) => { if (b === vscode.QuickInputButtons.Back) finish(BACK); });
    box.onDidHide(() => finish(undefined));
    check();
    box.show();
  });
}

interface PickOptions<T extends vscode.QuickPickItem> {
  title: string;
  step?: number;
  total?: number;
  placeholder: string;
  /** The items, or a load shown as busy (aborted when the picker closes). */
  items: T[] | ((signal: AbortSignal) => Promise<{ items: T[]; placeholder?: string }>);
  active?(items: readonly T[]): T | undefined;
  back?: boolean;
  busy?: string;
}

/** A picked item, or a button on one (Switch AI Model…'s Change Model and Change Thinking Level). */
interface Picked<T> { item: T; button?: vscode.QuickInputButton }

function pick<T extends vscode.QuickPickItem>(o: PickOptions<T>): Promise<Step<Picked<T>>> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<T>();
    // A wizard step stays open while the user looks something up elsewhere; a single list closes on focus out.
    Object.assign(qp, { title: o.title, step: o.step, totalSteps: o.total, placeholder: o.placeholder, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: o.step !== undefined });
    qp.buttons = o.back ? [vscode.QuickInputButtons.Back] : [];
    const controller = new AbortController();
    let done = false;
    const finish = (value: Step<Picked<T>>) => {
      if (done) return;
      done = true;
      controller.abort();
      resolve(value);
      qp.dispose();
    };
    const fill = (items: T[]) => {
      qp.items = items;
      const active = o.active?.(items);
      if (active) qp.activeItems = [active];
    };
    qp.onDidAccept(() => {
      const item = qp.selectedItems[0] ?? qp.activeItems[0];
      if (item) finish({ item });
    });
    qp.onDidTriggerItemButton((e) => finish({ item: e.item, button: e.button }));
    qp.onDidTriggerButton((b) => { if (b === vscode.QuickInputButtons.Back) finish(BACK); });
    qp.onDidHide(() => finish(undefined));
    if (Array.isArray(o.items)) fill(o.items);
    else {
      qp.busy = true;
      if (o.busy) qp.placeholder = o.busy;
      void o.items(controller.signal).then((r) => {
        if (done) return;
        qp.busy = false;
        qp.placeholder = r.placeholder ?? o.placeholder;
        fill(r.items);
      });
    }
    qp.show();
  });
}

interface ModelItem extends vscode.QuickPickItem { model?: AiModel; action?: "retry" | "manual" }
interface ProfileItem extends vscode.QuickPickItem { profile?: AiProfile; action?: "configure" }

const contextText = (tokens: number | undefined) => (tokens ? localize("{0}K context", Math.round(tokens / 1000)) : undefined);
const warning = (message: string): vscode.InputBoxValidationMessage => ({ message, severity: vscode.InputBoxValidationSeverity.Warning });
const error = (message: string): vscode.InputBoxValidationMessage => ({ message, severity: vscode.InputBoxValidationSeverity.Error });

export interface ConfigureDeps {
  providers: Readonly<Record<AiProtocol, AiProvider>>;
  keys: AiKeys;
}

export class AiConfigure {
  constructor(private readonly deps: ConfigureDeps) {}

  /** Linyra: Configure AI…; true when a profile was saved and is now in use. */
  async configure(): Promise<boolean> {
    const title = localize("Configure AI");
    const total = 5;
    const current = readAiSettings().active;
    let protocol: AiProtocol = current?.protocol ?? "anthropic";
    let baseUrl = "";
    let key: string | undefined;
    let model = "";
    let info: AiModel | undefined;
    let effort: AiEffort = "default";
    for (let step = 1; ;) {
      if (step === 1) {
        const items = PROTOCOLS.map((p) => ({
          label: protocolName(p), protocol: p,
          detail: p === "openai" ? localize("OpenAI, and servers that speak its API: Ollama, LM Studio, vLLM, gateways")
            : p === "anthropic" ? localize("Claude models through the Anthropic API or a compatible gateway")
            : localize("Gemini models through the Google AI (generativelanguage) API"),
        }));
        const r = await pick({ title, step, total, placeholder: localize("Choose the API protocol"), items, active: (all) => all.find((i) => i.protocol === protocol) });
        if (r === undefined || r === BACK) return false;
        if (r.item.protocol !== protocol) baseUrl = "";
        protocol = r.item.protocol;
        step = 2;
      } else if (step === 2) {
        const r = await input({
          title, step, total,
          value: baseUrl || (current?.protocol === protocol ? current.baseUrl : DEFAULT_BASE_URL[protocol]),
          prompt: localize("The base URL of the API. Change it for a local server or a gateway."),
          validate: (v) => {
            const checked = checkBaseUrl(v);
            if ("error" in checked) return error(checked.error);
            return isPlainRemote(checked.url) ? warning(localize("This address is not encrypted (http://): the API key would cross the network in the clear.")) : undefined;
          },
        });
        if (r === undefined) return false;
        if (r === BACK) { step = 1; continue; }
        const checked = checkBaseUrl(r);
        if (!("url" in checked)) continue;
        if (checked.url !== baseUrl) model = "";
        baseUrl = checked.url;
        step = 3;
      } else if (step === 3) {
        // A key already saved for this address can be kept without typing it again.
        const reusable = await this.savedKeyFor(protocol, baseUrl);
        const local = isLocalUrl(baseUrl);
        const r = await input({
          title, step, total, value: "", password: true,
          prompt: reusable ? localize("API key for {0}. Leave it empty to keep the saved key.", hostOf(baseUrl))
            : local ? localize("API key for {0}. A local server often needs none: leave it empty.", hostOf(baseUrl))
            : localize("API key for {0}. It is kept in VS Code's secret storage, never in settings.", hostOf(baseUrl)),
          placeholder: protocol === "anthropic" ? "sk-ant-…" : protocol === "gemini" ? "AIza…" : "sk-…",
          validate: (v) => (!v.trim() && !reusable && !local ? warning(localize("Without a key most providers answer 401.")) : undefined),
        });
        if (r === undefined) return false;
        if (r === BACK) { step = 2; continue; }
        key = r.trim() || reusable;
        step = 4;
      } else if (step === 4) {
        const r = await this.chooseModel({ title, step, total, protocol, baseUrl, key, preferred: model || (current?.protocol === protocol ? current.model : undefined) || DEFAULT_MODEL[protocol] });
        if (r === undefined) return false;
        if (r === BACK) { step = 3; continue; }
        if (r.id !== model) effort = "default";
        model = r.id;
        info = r.info;
        step = 5;
      } else if (step === 5) {
        const r = await this.chooseEffort({ title, step, total, protocol, model, info, current: effort });
        if (r === undefined) return false;
        if (r === BACK) { step = 4; continue; }
        effort = r;
        step = 6;
      } else {
        const settings = readAiSettings();
        const existing = sameConnection(settings.profiles, { protocol, baseUrl, model });
        const profile: AiProfile = { id: existing?.id ?? newProfileId(settings.profiles.map((p) => p.id)), protocol, baseUrl, model, effort, label: existing?.label ?? profileLabel(protocol, baseUrl, model) };
        const failed = await this.test(profile, key);
        if (failed) {
          const save = localize("Save Anyway");
          const back = localize("Back");
          const answer = await vscode.window.showErrorMessage(failed.kind === "cancelled" ? localize("The test was cancelled.") : localize("The test request to {0} failed.", profile.label),
            { modal: true, detail: failed.kind === "cancelled" ? undefined : failed.message }, save, back);
          if (answer === back) { step = 5; continue; }
          if (answer !== save) return false;
        }
        await this.deps.keys.set(profile.id, key, baseUrl);
        await writeAiSettings(upsertProfile(readAiSettings().profiles, profile), profile.id, true);
        void vscode.window.showInformationMessage(localize("Linyra AI now uses {0}.", profile.label));
        return true;
      }
    }
  }

  /** Linyra: Switch AI Model…: use another profile, or change a profile's model or thinking level. */
  async switchModel(): Promise<boolean> {
    const settings = readAiSettings();
    if (settings.profiles.length === 0) return this.configure();
    const changeModel: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("sparkle"), tooltip: localize("Change Model…") };
    const changeLevel: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("lightbulb"), tooltip: localize("Change Thinking Level…") };
    const items: ProfileItem[] = [
      ...settings.profiles.map((p) => ({
        label: p.label, profile: p,
        description: `${p.model} · ${effortLabel(p.effort)}`,
        detail: p.id === settings.active?.id ? localize("In use") : `${protocolName(p.protocol)} · ${hostOf(p.baseUrl)}`,
        buttons: [changeModel, changeLevel],
      })),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { label: `$(add) ${localize("Configure AI…")}`, action: "configure" },
    ];
    const r = await pick<ProfileItem>({ title: localize("Switch AI Model"), placeholder: localize("Choose the AI profile to use"), items, active: (all) => all.find((i) => i.profile?.id === settings.active?.id) });
    if (r === undefined || r === BACK) return false;
    if (r.item.action === "configure") return this.configure();
    let profile = r.item.profile;
    if (!profile) return false;
    if (r.button === changeModel || r.button === changeLevel) {
      let key: string | undefined;
      try {
        key = await this.deps.keys.keyFor(profile);
      } catch (e) {
        void vscode.window.showErrorMessage(asAiError(e).message);
        return false;
      }
      const title = localize("Switch AI Model");
      let model = profile.model;
      let info: AiModel | undefined;
      for (let step = r.button === changeModel ? 1 : 2; ;) {
        if (step === 1) {
          const m = await this.chooseModel({ title, step, total: 2, protocol: profile.protocol, baseUrl: profile.baseUrl, key, preferred: profile.model });
          if (m === undefined || m === BACK) return false;
          model = m.id;
          info = m.info;
          step = 2;
        } else {
          const e = await this.chooseEffort({ title, step: r.button === changeModel ? 2 : 1, total: r.button === changeModel ? 2 : 1, protocol: profile.protocol, model, info, current: model === profile.model ? profile.effort : "default", back: r.button === changeModel });
          if (e === undefined) return false;
          if (e === BACK) { step = 1; continue; }
          profile = withModel(profile, model, e);
          break;
        }
      }
    }
    const fresh = readAiSettings();
    await writeAiSettings(upsertProfile(fresh.profiles, profile), profile.id, true);
    vscode.window.setStatusBarMessage(localize("Linyra AI: {0} · {1}", profile.label, effortLabel(profile.effort)), 4000);
    return true;
  }

  /** Linyra: Remove AI Profile…: the profiles and their keys. */
  async removeProfile(): Promise<void> {
    const settings = readAiSettings();
    if (settings.profiles.length === 0) {
      void vscode.window.showInformationMessage(localize("There are no AI profiles to remove."));
      return;
    }
    const picked = await vscode.window.showQuickPick(settings.profiles.map((p) => ({ label: p.label, description: p.model, detail: hostOf(p.baseUrl), profile: p })),
      { canPickMany: true, title: localize("Remove AI Profile"), placeHolder: localize("Choose the AI profiles to remove") });
    if (!picked?.length) return;
    const remove = localize("Remove");
    const answer = await vscode.window.showWarningMessage(
      picked.length === 1 ? localize("Remove the AI profile {0}?", picked[0].label) : localize("Remove {0} AI profiles?", picked.length),
      { modal: true, detail: localize("Their API keys are deleted from VS Code's secret storage.") }, remove);
    if (answer !== remove) return;
    const ids = picked.map((p) => p.profile.id);
    for (const id of ids) await this.deps.keys.delete(id);
    const fresh = readAiSettings();
    await writeAiSettings(fresh.profiles.filter((p) => !ids.includes(p.id)), activeAfterRemoval(fresh.profiles, fresh.active?.id, ids));
  }

  /** A key saved for a profile with the same protocol and origin. */
  private async savedKeyFor(protocol: AiProtocol, baseUrl: string): Promise<string | undefined> {
    for (const p of readAiSettings().profiles) {
      if (p.protocol !== protocol || originOf(p.baseUrl) !== originOf(baseUrl)) continue;
      const saved = await this.deps.keys.saved(p.id);
      if (saved && saved.origin === originOf(baseUrl)) return saved.key;
    }
    return undefined;
  }

  private async chooseModel(o: { title: string; step: number; total: number; protocol: AiProtocol; baseUrl: string; key: string | undefined; preferred?: string }): Promise<Step<{ id: string; info?: AiModel }>> {
    const draft: AiProfile = { id: "draft", label: "", protocol: o.protocol, baseUrl: o.baseUrl, model: "", effort: "default" };
    const manual: ModelItem = { label: `$(edit) ${localize("Enter a Model ID…")}`, action: "manual", alwaysShow: true };
    for (;;) {
      const r = await pick<ModelItem>({
        title: o.title, step: o.step, total: o.total, back: true,
        placeholder: localize("Choose a model (type to search)"),
        busy: localize("Fetching the models of {0}…", hostOf(o.baseUrl)),
        items: async (signal) => {
          try {
            const models = await this.deps.providers[o.protocol].listModels(draft, o.key, signal);
            if (models.length === 0) return { items: [manual], placeholder: localize("{0} listed no models. Enter a model id.", hostOf(o.baseUrl)) };
            return {
              items: [...models.map((m) => ({ label: m.id, model: m, description: [m.label, contextText(m.contextTokens)].filter(Boolean).join(" · ") || undefined })), manual],
            };
          } catch (e) {
            const failure = asAiError(e, signal, o.baseUrl);
            return {
              placeholder: localize("Could not fetch the models. Try again, or enter a model id."),
              items: [{ label: `$(refresh) ${localize("Try Again")}`, detail: failure.message, action: "retry", alwaysShow: true }, manual],
            };
          }
        },
        active: (items) => items.find((i) => i.model?.id === o.preferred),
      });
      if (r === undefined || r === BACK) return r;
      if (r.item.action === "retry") continue;
      if (r.item.action === "manual") {
        const id = await input({ title: o.title, step: o.step, total: o.total, value: o.preferred ?? "", prompt: localize("The model id, as the provider names it"),
          validate: (v) => (v.trim() ? undefined : error(localize("Enter a model id."))) });
        if (id === undefined) return undefined;
        if (id === BACK) continue;
        return { id: id.trim() };
      }
      if (r.item.model) return { id: r.item.model.id, info: r.item.model };
    }
  }

  private async chooseEffort(o: { title: string; step: number; total: number; protocol: AiProtocol; model: string; info?: AiModel; current: AiEffort; back?: boolean }): Promise<Step<AiEffort>> {
    const choices = effortChoices(o.protocol, o.info ?? o.model);
    const unknown = (o.info?.efforts ?? knownEfforts(o.protocol, o.model)) === undefined;
    const items = choices.map((e) => ({ label: effortLabel(e), effort: e, description: e === "default" ? localize("The model decides; nothing is sent") : undefined }));
    const r = await pick({
      title: o.title, step: o.step, total: o.total, back: o.back ?? true,
      placeholder: unknown ? localize("Thinking level for {0}. The provider does not say which levels it takes: the test shows whether one works.", o.model)
        : localize("Thinking level for {0}", o.model),
      items, active: (all) => all.find((i) => i.effort === o.current),
    });
    return r === undefined || r === BACK ? r : r.item.effort;
  }

  /** One tiny request with the new profile; the failure, or undefined when it answered. */
  private test(profile: AiProfile, key: string | undefined): Thenable<AiError | undefined> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: localize("Testing {0}…", profile.label), cancellable: true }, async (_progress, token) => {
      const controller = new AbortController();
      const listener = token.onCancellationRequested(() => controller.abort());
      try {
        await this.deps.providers[profile.protocol].send(profile, key, { system: "", turns: [{ role: "user", content: "Reply with the word OK." }], signal: controller.signal });
        return undefined;
      } catch (e) {
        return asAiError(e, controller.signal, profile.baseUrl);
      } finally {
        listener.dispose();
      }
    });
  }
}
