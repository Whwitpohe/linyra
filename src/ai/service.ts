// The AiService every AI feature uses (registered in extension.ts): the active profile, its key,
// the prompt-size check, the protocol adapter, answers shown as Markdown previews, and the
// Configure / Switch / Remove commands.
import * as vscode from "vscode";
import { localize } from "../i18n";
import { outputLog } from "../outputLog";
import { AiConfigure } from "./configure";
import { asAiError, cancelled } from "./errors";
import { registerAi } from "./index";
import { nodeFetch } from "./net";
import { AiDocuments } from "./present";
import { estimateTokens, excludedBy, jsonText, overLimit, requestChars } from "./profileModel";
import { anthropicProvider } from "./providers/anthropic";
import { geminiProvider } from "./providers/gemini";
import { openAiProvider } from "./providers/openai";
import { AiKeys, readAiSettings } from "./store";
import { AiError, type AiProfile, type AiProtocol, type AiProvider, type AiRequest, type AiResponse, type AiService } from "./types";

/** when-clause context: linyra.ai.enabled and a profile with a model (menus of AI features use it). */
export const CONFIGURED_CONTEXT = "linyra.aiConfigured";

export function defaultProviders(): Record<AiProtocol, AiProvider> {
  const fetch = nodeFetch();
  return { openai: openAiProvider(fetch), anthropic: anthropicProvider(fetch), gemini: geminiProvider(fetch) };
}

export class LinyraAi implements AiService, vscode.Disposable {
  private readonly keys: AiKeys;
  private readonly documents = new AiDocuments();
  private readonly flows: AiConfigure;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when linyra.ai.* changes (a profile, the active one, on or off). */
  readonly onDidChange = this.changed.event;
  /** Prompts the user already allowed past linyra.ai.maxPromptTokens (one per request signal: a tool loop asks once). */
  private readonly allowedLarge = new WeakSet<AbortSignal>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(context: vscode.ExtensionContext, private readonly providers: Readonly<Record<AiProtocol, AiProvider>> = defaultProviders()) {
    this.keys = new AiKeys(context.secrets);
    this.flows = new AiConfigure({ providers, keys: this.keys });
    this.disposables.push(this.documents, this.changed, vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("linyra.ai")) return;
      this.updateContext();
      this.changed.fire();
    }));
    this.updateContext();
    registerAi(this);
  }

  /** Configure AI…, Switch AI Model…, Remove AI Profile…. */
  commands(): vscode.Disposable[] {
    return [
      vscode.commands.registerCommand("linyra.ai.configure", () => this.flows.configure()),
      vscode.commands.registerCommand("linyra.ai.switchModel", () => this.flows.switchModel()),
      vscode.commands.registerCommand("linyra.ai.removeProfile", () => this.flows.removeProfile()),
    ];
  }

  get configured(): boolean {
    const s = readAiSettings();
    return s.enabled && !!s.active?.model;
  }

  get profile(): AiProfile | undefined {
    return readAiSettings().active;
  }

  private updateContext(): void {
    void vscode.commands.executeCommand("setContext", CONFIGURED_CONTEXT, this.configured);
  }

  async ensureReady(): Promise<boolean> {
    if (this.configured) return true;
    const s = readAiSettings();
    if (s.active?.model && !s.enabled) {
      const on = localize("Turn On");
      if (await vscode.window.showInformationMessage(localize("Linyra AI is off. Turn it on to use {0}?", s.active.label), on) !== on) return false;
      await vscode.workspace.getConfiguration("linyra.ai").update("enabled", true, vscode.ConfigurationTarget.Global);
      return this.configured;
    }
    const configure = localize("Configure AI…");
    const message = s.profiles.length > 0 ? localize("Choose the AI profile to use first.") : localize("Linyra AI is not set up yet: choose a provider, a model and an API key first.");
    if (await vscode.window.showInformationMessage(message, configure) !== configure) return false;
    return s.profiles.length > 0 ? await this.flows.switchModel() && this.configured : await this.flows.configure() && this.configured;
  }

  async ask(request: AiRequest): Promise<AiResponse> {
    const s = readAiSettings();
    const profile = s.active;
    if (!s.enabled || !profile?.model) throw new AiError(localize("Linyra AI is not set up. Run Linyra: Configure AI…"), "notConfigured");
    if (request.signal.aborted) throw cancelled();
    const tokens = estimateTokens(requestChars(request));
    if (overLimit(tokens, s.maxPromptTokens) && !this.allowedLarge.has(request.signal)) {
      const send = localize("Send");
      const answer = await vscode.window.showWarningMessage(localize("This request is about {0} tokens, more than linyra.ai.maxPromptTokens ({1}). Send it to {2}?", tokens.toLocaleString(), s.maxPromptTokens.toLocaleString(), profile.label),
        { modal: true, detail: localize("Large requests cost more and take longer. Leave out files with linyra.ai.exclude, or raise the limit.") }, send);
      if (answer !== send) throw cancelled();
      this.allowedLarge.add(request.signal);
    }
    const key = await this.keys.keyFor(profile);
    const started = Date.now();
    let response: AiResponse;
    try {
      response = await this.providers[profile.protocol].send(profile, key, request);
    } catch (e) {
      const failure = asAiError(e, request.signal, profile.baseUrl);
      if (failure.kind !== "cancelled") outputLog().warn(`AI ${profile.protocol} ${profile.model}: ${failure.kind}: ${failure.message}`);
      throw failure;
    }
    const usage = response.usage ? `, ${response.usage.inputTokens ?? "?"} in / ${response.usage.outputTokens ?? "?"} out` : "";
    outputLog().info(`AI ${profile.protocol} ${response.model ?? profile.model}: ${response.stop}${usage}, ${Date.now() - started} ms`);
    if (response.stop === "refusal") throw new AiError(localize("The model declined this request."), "refusal");
    return request.json ? { ...response, text: jsonText(response.text) } : response;
  }

  present(title: string, run: (write: (markdown: string) => void, signal: AbortSignal) => Promise<void>): Promise<void> {
    return this.documents.present(title, run);
  }

  excluded(path: string): boolean {
    return excludedBy(readAiSettings().exclude, path, process.platform !== "linux");
  }

  dispose(): void {
    registerAi(undefined);
    for (const d of this.disposables) d.dispose();
  }
}
