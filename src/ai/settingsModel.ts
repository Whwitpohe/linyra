// What the Linyra AI page decides, without VS Code or the DOM: the form's draft and its checks,
// which stored key a draft may use, the thinking levels on offer, the model list's filter, Test
// Connection's report in plain words, the row and removal texts, and the host's check of what the
// webview sent. Pure: no vscode import; the tests are in settingsModel.test.ts.
import { localize } from "../i18n";
import { hostOf } from "./errors";
import {
  activeAfterRemoval, checkBaseUrl, DEFAULT_BASE_URL, DEFAULT_MODEL, effortChoices, effortLabel, isEffort, isLocalUrl, isPlainRemote, isProtocol,
  knownEfforts, originOf, profileLabel, protocolName,
} from "./profileModel";
import type { DraftProfile, KeyChoice, ProfileRow, StepResult, TestOutcome } from "./settingsProtocol";
import type { AiEffort, AiModel, AiProfile, AiProtocol } from "./types";

export interface FieldMessage { severity: "error" | "warning" | "info"; text: string }

// ── The draft ──────────────────────────────────────────────────────────────

export function protocolDetail(protocol: AiProtocol): string {
  switch (protocol) {
    case "openai": return localize("OpenAI, and servers that speak its API: Ollama, LM Studio, vLLM, gateways");
    case "anthropic": return localize("Claude models through the Anthropic API or a compatible gateway");
    case "gemini": return localize("Gemini models through the Google AI (generativelanguage) API");
  }
}

/** Addresses offered as one click under the field: the usual local servers. */
export const ADDRESS_PRESETS: Readonly<Record<AiProtocol, readonly { name: string; url: string }[]>> = {
  openai: [{ name: "OpenAI", url: DEFAULT_BASE_URL.openai }, { name: "Ollama", url: "http://localhost:11434/v1" }, { name: "LM Studio", url: "http://localhost:1234/v1" }],
  anthropic: [],
  gemini: [],
};

export const keyPlaceholder = (protocol: AiProtocol): string => (protocol === "anthropic" ? "sk-ant-…" : protocol === "gemini" ? "AIza…" : "sk-…");

export function newDraft(protocol: AiProtocol = "anthropic"): DraftProfile {
  return { protocol, baseUrl: DEFAULT_BASE_URL[protocol], model: DEFAULT_MODEL[protocol] ?? "", effort: "default", label: "" };
}

/** A saved profile in the form. A generated name shows as empty, so it keeps following the model. */
export function draftOf(p: Pick<ProfileRow, "id" | "label" | "protocol" | "baseUrl" | "model" | "effort">): DraftProfile {
  return { id: p.id, protocol: p.protocol, baseUrl: p.baseUrl, model: p.model, effort: p.effort, label: p.label === profileLabel(p.protocol, p.baseUrl, p.model) ? "" : p.label };
}

/** The address as it would be saved; undefined while it is not one. */
export function addressOf(baseUrl: string): string | undefined {
  const checked = checkBaseUrl(baseUrl);
  return "url" in checked ? checked.url : undefined;
}

/** The provider's own address: Anthropic and Gemini show it as text, not as a field. */
export const isDefaultAddress = (d: Pick<DraftProfile, "protocol" | "baseUrl">): boolean => addressOf(d.baseUrl) === DEFAULT_BASE_URL[d.protocol];

/** Another provider: its address replaces the old one's default (an address the user typed stays), the model starts over. */
export function withProtocol(d: DraftProfile, protocol: AiProtocol): DraftProfile {
  if (protocol === d.protocol) return d;
  const typed = d.baseUrl.trim() !== "" && !isDefaultAddress(d);
  return { ...d, protocol, baseUrl: typed ? d.baseUrl : DEFAULT_BASE_URL[protocol], model: DEFAULT_MODEL[protocol] ?? "", effort: "default" };
}

/** The generated name, or the one typed. */
export const draftName = (d: DraftProfile): string => d.label.trim() || profileLabel(d.protocol, addressOf(d.baseUrl) ?? d.baseUrl.trim(), d.model.trim());

// ── Keys ───────────────────────────────────────────────────────────────────

/**
 * The stored key a draft may use: its own, while the address keeps the origin it was entered for;
 * else another profile's of the same provider and origin; else none ("elsewhere": its own key
 * exists but was entered for another origin, and is never sent here).
 */
export type KeyState =
  | { kind: "stored"; origin: string }
  | { kind: "shared"; from: ProfileRow; origin: string }
  | { kind: "elsewhere"; origin: string }
  | { kind: "none" };

export function keyState(d: Pick<DraftProfile, "id" | "protocol" | "baseUrl">, profiles: readonly ProfileRow[]): KeyState {
  const own = d.id === undefined ? undefined : profiles.find((p) => p.id === d.id);
  const ownOrigin = own?.key.stored ? own.key.origin : undefined;
  const address = addressOf(d.baseUrl);
  // While the address is being typed, the key line stays as it was.
  if (!address) return ownOrigin ? { kind: "stored", origin: ownOrigin } : { kind: "none" };
  const origin = originOf(address);
  if (ownOrigin === origin) return { kind: "stored", origin };
  const from = profiles.find((p) => p.id !== d.id && p.protocol === d.protocol && p.key.stored && p.key.origin === origin);
  if (from) return { kind: "shared", from, origin };
  return ownOrigin ? { kind: "elsewhere", origin: ownOrigin } : { kind: "none" };
}

/** The key field: the stored key's line (auto), its field with the stored key kept when left empty (replace), or no key unless one is typed (remove). */
export type KeyMode = "auto" | "replace" | "remove";

export const usesStoredKey = (state: KeyState): state is Extract<KeyState, { kind: "stored" | "shared" }> => state.kind === "stored" || state.kind === "shared";

/** Whether the field shows the stored key's line (Replace, Remove) rather than the password field. */
export const showsStoredKey = (state: KeyState, mode: KeyMode): boolean => usesStoredKey(state) && mode === "auto";

export function keyChoice(state: KeyState, mode: KeyMode, typed: string): KeyChoice {
  const value = typed.trim();
  if (value && !showsStoredKey(state, mode)) return { kind: "new", value };
  if (mode === "remove") return { kind: "none" };
  if (state.kind === "stored") return { kind: "keep" };
  if (state.kind === "shared") return { kind: "from", profileId: state.from.id };
  return { kind: "none" };
}

/** The stored key's line. */
export function storedKeyText(state: KeyState): string {
  if (state.kind === "shared") return localize("Uses the key stored for “{0}”", state.from.label);
  return state.kind === "stored" ? localize("Stored for {0}", hostOf(state.origin)) : "";
}

/** The line under the password field: what happens to the key. */
export function keyNote(d: Pick<DraftProfile, "baseUrl">, state: KeyState, mode: KeyMode): string {
  if (usesStoredKey(state) && mode === "replace") return localize("Leave it empty to keep the stored key.");
  if (usesStoredKey(state) && mode === "remove") return state.kind === "stored" ? localize("The stored key is deleted when you save.") : localize("This profile is saved without a key.");
  const address = addressOf(d.baseUrl);
  if (address && isLocalUrl(address)) return localize("A server on this machine or your network often needs no key: leave it empty.");
  return localize("It is kept in VS Code's secret storage, never in settings.");
}

/** A typed key is bound to the address it was typed for: the address moved to another origin, so it was cleared. */
export const droppedKeyText = (origin: string): string => localize("The key you typed was for {0}, so it was cleared. Type it again for this address.", hostOf(origin));

/** Text from a provider without the key in it: some gateways echo the key they were given. */
export function redactKey(text: string, key: string | undefined): string;
export function redactKey(text: string | undefined, key: string | undefined): string | undefined;
export function redactKey(text: string | undefined, key: string | undefined): string | undefined {
  return text && key && key.length >= 4 ? text.split(key).join("…") : text;
}

/** A key typed with characters a header cannot carry, or none where one is usually needed. */
export function keyMessage(d: Pick<DraftProfile, "baseUrl">, state: KeyState, choice: KeyChoice): FieldMessage | undefined {
  if (choice.kind === "new") {
    if (/[^\x20-\x7e]/.test(choice.value)) return { severity: "error", text: localize("An API key is plain ASCII text, and this one has other characters. Paste it again.") };
    if (/\s/.test(choice.value)) return { severity: "warning", text: localize("The key has a space in it. Paste it again if the test fails.") };
    return undefined;
  }
  if (choice.kind !== "none") return undefined;
  const address = addressOf(d.baseUrl);
  if (state.kind === "elsewhere" && address) {
    return { severity: "warning", text: localize("The key stored for {0} is never sent to {1}, and saving deletes it. Enter a key for this address.", state.origin, originOf(address)) };
  }
  return address && !isLocalUrl(address) ? { severity: "warning", text: localize("Without a key most providers answer 401.") } : undefined;
}

// ── Checks ─────────────────────────────────────────────────────────────────

export interface FormCheck {
  baseUrl?: FieldMessage;
  key?: FieldMessage;
  model?: FieldMessage;
  label?: FieldMessage;
  /** No error: Save and Test Connection can go. */
  ok: boolean;
}

export const MAX_LABEL = 120;

export function checkForm(d: DraftProfile, profiles: readonly ProfileRow[], state: KeyState, choice: KeyChoice): FormCheck {
  const out: FormCheck = { ok: true };
  const checked = checkBaseUrl(d.baseUrl);
  if ("error" in checked) out.baseUrl = { severity: "error", text: checked.error };
  else if (isPlainRemote(checked.url)) out.baseUrl = { severity: "warning", text: localize("This address is not encrypted (http://): the API key would cross the network in the clear.") };
  out.key = keyMessage(d, state, choice);
  const model = d.model.trim();
  if (!model) out.model = { severity: "error", text: localize("Enter a model id, or pick one from the list.") };
  else if (/\s/.test(model)) out.model = { severity: "warning", text: localize("Model ids have no spaces: check this one.") };
  const name = draftName(d);
  if (d.label.trim().length > MAX_LABEL) out.label = { severity: "error", text: localize("Keep the name under {0} characters.", MAX_LABEL) };
  else if (profiles.some((p) => p.id !== d.id && p.label === name)) {
    out.label = { severity: "info", text: localize("“{0}” is already the name of a profile. Give this one its own name to tell them apart.", name) };
  }
  out.ok = ![out.baseUrl, out.key, out.model, out.label].some((m) => m?.severity === "error");
  return out;
}

/** Whether the model list can be read now: a valid address, and a key unless the server is local. */
export function modelsReadable(d: Pick<DraftProfile, "baseUrl">, choice: KeyChoice): "yes" | "address" | "key" {
  const address = addressOf(d.baseUrl);
  if (!address) return "address";
  return choice.kind === "none" && !isLocalUrl(address) ? "key" : "yes";
}

// ── Models and thinking levels ─────────────────────────────────────────────

export function contextText(tokens: number | undefined): string | undefined {
  if (!tokens) return undefined;
  return tokens >= 1_000_000 ? localize("{0}M context", Number((tokens / 1_000_000).toFixed(1))) : localize("{0}K context", Math.round(tokens / 1000));
}

/** The second line of a model in the list: its name (when not the id) and its context window. */
export const modelDescription = (m: AiModel): string => [m.label && m.label !== m.id ? m.label : undefined, contextText(m.contextTokens)].filter(Boolean).join(" · ");

/**
 * The models for the text in the field: every model while it is empty or names one exactly (the
 * list opened on a chosen model shows the rest), else ids that start with it (or a segment after
 * / or :), then ids and names that contain it. Case-insensitive; the provider's order otherwise.
 */
export function filterModels(models: readonly AiModel[], text: string): AiModel[] {
  const q = text.trim().toLowerCase();
  if (!q || models.some((m) => m.id.toLowerCase() === q)) return [...models];
  const starts: AiModel[] = [];
  const contains: AiModel[] = [];
  for (const m of models) {
    const id = m.id.toLowerCase();
    if (id.split(/[/:]/).some((part) => part.startsWith(q)) || id.startsWith(q)) starts.push(m);
    else if (id.includes(q) || (m.label ?? "").toLowerCase().includes(q)) contains.push(m);
  }
  return [...starts, ...contains];
}

export const modelCount = (n: number): string => (n === 1 ? localize("1 model") : localize("{0} models", n));

export type ModelsLoad = { state: "idle" } | { state: "loading" } | { state: "loaded"; count: number } | { state: "failed"; error: string };

/** The line under the model field: what the list is doing, or why there is none. */
export function modelsNote(load: ModelsLoad, readable: "yes" | "address" | "key", baseUrl: string): FieldMessage | undefined {
  if (readable === "address") return undefined;
  if (readable === "key") return { severity: "info", text: localize("Enter the API key to load the model list, or type the model id.") };
  const host = hostOf(baseUrl);
  switch (load.state) {
    case "idle": return { severity: "info", text: localize("Open the list (↓) to load the models of {0}.", host) };
    case "loading": return { severity: "info", text: localize("Fetching the models of {0}…", host) };
    case "loaded": return load.count === 0 ? { severity: "warning", text: localize("{0} listed no models. Enter a model id.", host) }
      : { severity: "info", text: localize("{0} from {1}: open the list with ↓ or type to filter.", modelCount(load.count), host) };
    case "failed": return { severity: "warning", text: load.error };
  }
}

export interface EffortView {
  /** Default first, then the levels the model takes (every level of the protocol when unknown). */
  choices: AiEffort[];
  /** The provider or the model id says which levels it takes. */
  known: boolean;
}

/** The thinking levels for the model in the field; `info` is the listed model it was picked as, if any. */
export function effortView(protocol: AiProtocol, model: string, info?: AiModel): EffortView {
  const id = model.trim();
  const listed = info && info.id === id ? info : undefined;
  return { choices: effortChoices(protocol, listed ?? id), known: (listed?.efforts ?? knownEfforts(protocol, id)) !== undefined };
}

/** The level kept when the model changes: the same if the new model takes it, else Default. */
export const fitEffort = (effort: AiEffort, view: EffortView): AiEffort => (view.choices.includes(effort) ? effort : "default");

export function effortNote(view: EffortView, model: string, effort: AiEffort): string {
  const id = model.trim();
  if (!id) return localize("Choose a model to see the thinking levels it takes.");
  if (view.choices.length <= 1) return localize("{0} does not take a thinking level.", id);
  if (!view.known) return localize("The provider does not say which levels {0} takes: Test Connection shows whether one works.", id);
  return effort === "default" ? localize("Default lets the model decide: nothing is sent.") : localize("Higher levels think longer: better on hard questions, slower and more tokens.");
}

// ── The list ───────────────────────────────────────────────────────────────

/** A row's second line: the model (unless the name says it), provider, address, thinking level, key. */
export function profileFacts(p: ProfileRow): string[] {
  const key = !p.key.stored ? localize("No key") : p.key.origin === originOf(p.baseUrl) ? localize("Key stored") : localize("Key entered for another address");
  return [...(p.label.includes(p.model) ? [] : [p.model]), protocolName(p.protocol), hostOf(p.baseUrl), localize("Thinking: {0}", effortLabel(p.effort)), key];
}

/** What Remove takes away, said before it does. */
export function removalText(target: ProfileRow, profiles: readonly ProfileRow[], activeId: string | undefined): { question: string; details: string[] } {
  const details = [target.key.stored ? localize("Its API key is deleted from VS Code's secret storage.") : localize("It has no stored API key.")];
  if (target.id === activeId) {
    const next = profiles.find((p) => p.id === activeAfterRemoval(profiles, activeId, [target.id]));
    details.push(next ? localize("Linyra AI will use “{0}” instead.", next.label) : localize("No profile is left: the AI features wait until you add one."));
  }
  return { question: localize("Remove the AI profile “{0}”?", target.label), details };
}

// ── Test Connection ────────────────────────────────────────────────────────

export interface ReportLine {
  status: "ok" | "warning" | "failed" | "skipped";
  text: string;
  /** What to do about it. */
  next?: string;
  /** The provider's own words. */
  detail?: string;
}

export interface TestReport { ok: boolean; title: string; lines: ReportLine[] }

export const duration = (ms: number): string => (ms < 1000 ? localize("{0} ms", Math.max(0, Math.round(ms))) : localize("{0} s", (ms / 1000).toFixed(1)));

type Failure = Extract<StepResult, { ok: false }>;

/** Why the model list could not be read, said as Test Connection says it; the id can still be typed unless the key was refused. */
export function modelsFailure(r: Failure, d: Pick<DraftProfile, "protocol" | "baseUrl" | "model" | "effort">, keyed: boolean): string {
  const line = failure(r, d, keyed, "list");
  const said = r.status === undefined ? localize("The model list could not be read. {0}", line.text) : [line.text, line.next].filter(Boolean).join(" ");
  return r.kind === "auth" ? said : `${said} ${localize("You can still type the model id.")}`;
}
type Tested = Pick<DraftProfile, "protocol" | "baseUrl" | "model" | "effort">;

function failure(r: Failure, d: Tested, keyed: boolean, step: "list" | "send"): ReportLine {
  const host = hostOf(d.baseUrl);
  const page = r.html ? localize("It answered with a web page instead of an API response: a proxy or sign-in page may be in the way.") : undefined;
  const line = (text: string, next?: string): ReportLine => ({
    status: "failed", text, next: [next, page].filter(Boolean).join(" ") || undefined, detail: r.detail ? localize("The provider says: {0}", r.detail) : undefined,
  });
  switch (r.status) {
    case 401: return line(localize("{0} did not accept the API key (401).", host),
      keyed ? localize("Check the key, or replace it with a new one from the provider's console.") : localize("This server needs an API key: enter it above."));
    case 403: return line(localize("Access denied (403)."), localize("The key cannot use this model or address. Check the model id and your account's access."));
    case 404: return line(step === "list" ? localize("{0} has no model list at this address (404).", host) : localize("Not found (404)."),
      d.protocol === "openai" ? localize("Check the address (OpenAI-compatible servers usually end in /v1) and the model id.") : localize("Check the address and the model id."));
    case 400: case 422: return line(localize("The provider rejected the request ({0}).", r.status),
      step === "send" && d.effort !== "default" ? localize("{0} may not take the thinking level {1}: try Default.", d.model, effortLabel(d.effort)) : localize("Check the model id."));
    case 429: return line(localize("Rate limit or quota reached (429)."), localize("The address and the key work. Wait a moment, or check your plan's quota."));
    case 408: case 504: return line(localize("The provider timed out ({0}). Try again.", r.status));
  }
  if (r.status !== undefined && r.status >= 500) return line(localize("The provider had a problem ({0}). Try again later.", r.status));
  // No HTTP answer (DNS, refused, certificate, proxy) or another status: the error's own sentence names the cause and the fix.
  return { status: "failed", text: r.message };
}

/** Test Connection's two steps in plain words: what worked, and what failed with what to do next. */
export function testReport(o: TestOutcome, d: Tested): TestReport {
  const stopped = (r: StepResult | undefined) => r?.ok === false && r.kind === "cancelled";
  if (stopped(o.list) || stopped(o.send)) return { ok: false, title: localize("Test stopped."), lines: [] };
  const host = hostOf(d.baseUrl);
  const model = d.model.trim();
  const lines: ReportLine[] = [];
  const list = o.list;
  if (list.ok) {
    const count = list.count ?? 0;
    lines.push({
      status: "ok",
      text: count === 0 ? localize("Reached {0}, but it listed no models.", host)
        : o.keyed ? localize("Reached {0} and the key was accepted ({1}).", host, modelCount(count)) : localize("Reached {0} ({1}).", host, modelCount(count)),
    });
  } else if (o.send?.ok) {
    // The model answered: the address and the key work, the server just keeps its list to itself.
    lines.push({ status: "warning", text: localize("{0} does not list its models: type the model id.", host) });
  } else {
    lines.push(failure(list, d, o.keyed, "list"));
  }
  const send = o.send;
  if (!send) {
    lines.push({ status: "skipped", text: localize("{0} was not tried: the step above has to work first.", model) });
  } else if (send.ok) {
    const parts = [send.refused ? localize("{0} answered in {1}, declining the test prompt: the connection works.", model, duration(send.ms)) : localize("{0} answered in {1}.", model, duration(send.ms))];
    if (send.answeredBy && send.answeredBy !== model) parts.push(localize("The answer came from {0}.", send.answeredBy));
    if (d.effort !== "default") parts.push(localize("Thinking level {0} was accepted.", effortLabel(d.effort)));
    lines.push({ status: "ok", text: parts.join(" ") });
  } else {
    lines.push(failure(send, d, o.keyed, "send"));
  }
  const ok = send?.ok === true;
  return { ok, title: ok ? localize("The connection works.") : localize("The test failed."), lines };
}

// ── The host's checks of what the webview sent ─────────────────────────────

const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

/** A draft from the webview, checked: the address normalized, the model required unless `model` is false. */
export function checkDraft(raw: unknown, need: { model: boolean } = { model: true }): { draft: DraftProfile } | { error: string } {
  const incomplete = { error: localize("The form arrived incomplete. Try again.") };
  if (!raw || typeof raw !== "object") return incomplete;
  const r = raw as Record<string, unknown>;
  if (r.id !== undefined && !(typeof r.id === "string" && r.id.trim() && r.id.length <= 200)) return incomplete;
  if (!isProtocol(r.protocol)) return incomplete;
  const baseUrl = text(r.baseUrl, 2000);
  if (baseUrl === undefined) return incomplete;
  const checked = checkBaseUrl(baseUrl);
  if ("error" in checked) return { error: checked.error };
  const model = text(r.model, 300)?.trim() ?? "";
  if (need.model && !model) return { error: localize("Enter a model id, or pick one from the list.") };
  const label = text(r.label, 2000)?.trim() ?? "";
  if (label.length > MAX_LABEL) return { error: localize("Keep the name under {0} characters.", MAX_LABEL) };
  return { draft: { id: r.id as string | undefined, protocol: r.protocol, baseUrl: checked.url, model, effort: isEffort(r.effort) ? r.effort : "default", label } };
}

export function checkKeyChoice(raw: unknown): KeyChoice | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "keep": case "none": return { kind: r.kind };
    case "from": return typeof r.profileId === "string" && r.profileId ? { kind: "from", profileId: r.profileId } : undefined;
    case "new": {
      const value = text(r.value, 8192)?.trim();
      return value && !/[^\x20-\x7e]/.test(value) ? { kind: "new", value } : undefined;
    }
    default: return undefined;
  }
}

/** The profile a checked draft saves as: its id, and the generated name when none was typed. */
export function profileOf(d: DraftProfile, id: string): AiProfile {
  return { id, protocol: d.protocol, baseUrl: d.baseUrl, model: d.model, effort: d.effort, label: d.label || profileLabel(d.protocol, d.baseUrl, d.model) };
}

/** The active id after a save: the saved profile when it is to be used, else the one in use stays (written out, so a second profile does not unset the only one). */
export const activeAfterSave = (savedId: string, use: boolean, activeBefore: string | undefined): string | undefined => (use ? savedId : activeBefore);
