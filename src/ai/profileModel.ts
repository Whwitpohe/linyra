// What Configure AI…, Switch AI Model… and the service decide, without VS Code: saved profiles,
// defaults per protocol, the thinking levels a model takes, the prompt-size estimate and the
// exclude globs. Pure: no vscode import; the tests are here.
import { localize } from "../i18n";
import type { AiEffort, AiModel, AiProfile, AiProtocol, AiRequest } from "./types";

export const PROTOCOLS: readonly AiProtocol[] = ["openai", "anthropic", "gemini"];

export const DEFAULT_BASE_URL: Readonly<Record<AiProtocol, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

/** The model picked first when the provider lists it. */
export const DEFAULT_MODEL: Readonly<Partial<Record<AiProtocol, string>>> = { anthropic: "claude-opus-5-5" };

/** Every level, least thinking first ("default" is not one: it sends nothing). */
export const EFFORT_ORDER: readonly AiEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The levels each protocol has a value for; a level outside its set is left out of the request. */
export const PROTOCOL_EFFORTS: Readonly<Record<AiProtocol, readonly AiEffort[]>> = {
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  gemini: ["none", "minimal", "low", "medium", "high"],
};

export const isProtocol = (v: unknown): v is AiProtocol => v === "openai" || v === "anthropic" || v === "gemini";
export const isEffort = (v: unknown): v is AiEffort => v === "default" || (EFFORT_ORDER as readonly unknown[]).includes(v);

export function protocolName(protocol: AiProtocol): string {
  switch (protocol) {
    case "openai": return localize("OpenAI-compatible");
    case "anthropic": return "Anthropic";
    case "gemini": return "Google Gemini";
  }
}

export function effortLabel(effort: AiEffort): string {
  switch (effort) {
    case "default": return localize("Default");
    case "none": return localize("None");
    case "minimal": return localize("Minimal");
    case "low": return localize("Low");
    case "medium": return localize("Medium");
    case "high": return localize("High");
    case "xhigh": return localize("Extra High");
    case "max": return localize("Max");
  }
}

// ── Addresses ──────────────────────────────────────────────────────────────

/** The base URL as typed, checked and without a trailing slash; or why it cannot be used. */
export function checkBaseUrl(text: string): { url: string } | { error: string } {
  const value = text.trim();
  if (!value) return { error: localize("Enter the address of the API, for example {0}.", DEFAULT_BASE_URL.openai) };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: localize("This is not an address. Start it with https:// or http://.") };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: localize("Use an https:// or http:// address.") };
  if (url.username || url.password) return { error: localize("Leave the key out of the address: the next step asks for it.") };
  if (url.search || url.hash) return { error: localize("Leave out the query and the fragment (after ? or #).") };
  return { url: url.href.replace(/\/+$/, "") };
}

/** A server on this machine or the local network: an API key is often not needed. */
export function isLocalUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host === "0.0.0.0"
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/** An http:// address that leaves this machine: a key would cross the network in the clear. */
export function isPlainRemote(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === "http:" && !isLocalUrl(baseUrl);
  } catch {
    return false;
  }
}

/** Where a key may be sent: scheme, host and port. A saved key is only ever sent back there. */
export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

export function isFirstPartyAnthropic(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

export const isFirstPartyOpenAi = (baseUrl: string): boolean => {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
};

// ── Anthropic model facts ──────────────────────────────────────────────────

/** The beta header of server-side fallback's "default" form. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** Models whose refusals the first-party API can retry on its recommended fallback model. */
export const FALLBACK_MODELS: readonly string[] = ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"];

/** Server-side fallback (fallbacks: "default"): on api.anthropic.com only, for the models that take it. */
export function anthropicFallbacks(profile: Pick<AiProfile, "baseUrl" | "model">): boolean {
  return isFirstPartyAnthropic(profile.baseUrl) && FALLBACK_MODELS.includes(profile.model);
}

/** A Claude model id's family and version (claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5-20251001). */
export function claudeVersion(model: string): { family: string; major: number; minor: number } | undefined {
  const m = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?![\d])/.exec(model.toLowerCase());
  return m ? { family: m[1], major: Number(m[2]), minor: m[3] === undefined ? 0 : Number(m[3]) } : undefined;
}

const atLeast = (v: { major: number; minor: number }, major: number, minor: number) => v.major > major || (v.major === major && v.minor >= minor);

/** Models that take thinking: { type: "adaptive" } (Opus and Sonnet 4.6 on, Haiku 5 on, Fable, Mythos). Others get no thinking field. */
export function anthropicAdaptive(model: string): boolean {
  const v = claudeVersion(model);
  if (!v) return false;
  if (v.family === "fable" || v.family === "mythos") return true;
  if (v.family === "haiku") return v.major >= 5;
  return atLeast(v, 4, 6);
}

/** Effort levels by model id, for when the Models API did not say (Switch AI Model…, gateways). */
function anthropicEfforts(model: string): AiEffort[] | undefined {
  const v = claudeVersion(model);
  if (!v) return undefined;
  if (v.family === "fable" || v.family === "mythos" || (v.family === "haiku" && v.major >= 5) || (v.family !== "haiku" && atLeast(v, 4, 7))) return ["low", "medium", "high", "xhigh", "max"];
  if (v.family !== "haiku" && atLeast(v, 4, 6)) return ["low", "medium", "high", "max"];
  if (v.family === "opus" && atLeast(v, 4, 5)) return ["low", "medium", "high"];
  return [];
}

// ── OpenAI and Gemini model facts ──────────────────────────────────────────

/** reasoning_effort by model id; undefined: unknown (an OpenAI-compatible server's own models). */
function openAiEfforts(model: string): AiEffort[] | undefined {
  const id = model.toLowerCase().replace(/^openai\//, "");
  if (/^(gpt-4|gpt-3\.5|chatgpt-|gpt-5(\.\d+)?-chat)/.test(id) || /^o1-(mini|preview)/.test(id)) return [];
  if (/^o[134](-|$)/.test(id)) return ["low", "medium", "high"];
  if (/-pro(-|$)/.test(id)) return undefined;
  if (/^gpt-5\.[2-9]/.test(id) || /^gpt-5\.1-codex-max/.test(id)) return /codex/.test(id) ? ["low", "medium", "high", "xhigh"] : ["none", "low", "medium", "high", "xhigh"];
  if (/^gpt-5\.1/.test(id)) return /codex/.test(id) ? ["low", "medium", "high"] : ["none", "low", "medium", "high"];
  if (/^gpt-5-codex/.test(id)) return ["low", "medium", "high"];
  if (/^gpt-5(-|$)/.test(id)) return ["minimal", "low", "medium", "high"];
  return undefined;
}

/** Gemini 2.5 thinks by token budget; Gemini 3 and later by level (generationConfig.thinkingConfig). */
export const geminiUsesBudget = (model: string): boolean => /^(models\/)?gemini-2\.5-/.test(model.toLowerCase());

function geminiEfforts(model: string): AiEffort[] | undefined {
  const id = model.toLowerCase().replace(/^models\//, "");
  if (/^gemini-2\.5-pro/.test(id)) return ["low", "medium", "high"];
  if (/^gemini-2\.5-flash/.test(id)) return ["none", "low", "medium", "high"];
  if (/^gemini-(1\.|2\.0)/.test(id)) return [];
  if (/^gemini-3-pro/.test(id)) return ["low", "high"];
  if (/^gemini-3\.\d+-pro/.test(id) || /^gemini-3\.8-flash/.test(id) || /^gemini-[4-9]/.test(id)) return ["low", "medium", "high"];
  if (/^gemini-3(\.\d+)?-flash/.test(id)) return ["minimal", "low", "medium", "high"];
  if (/^gemma-[4-9]/.test(id)) return ["minimal", "high"];
  if (/^gemma-/.test(id)) return [];
  return undefined;
}

/** The levels a model is known to take, without asking the provider; undefined when unknown. */
export function knownEfforts(protocol: AiProtocol, model: string): AiEffort[] | undefined {
  switch (protocol) {
    case "openai": return openAiEfforts(model);
    case "anthropic": return anthropicEfforts(model);
    case "gemini": return geminiEfforts(model);
  }
}

/** The thinking levels to offer: Default, then what the model takes (every level of the protocol when unknown). */
export function effortChoices(protocol: AiProtocol, model: Pick<AiModel, "id" | "efforts"> | string): AiEffort[] {
  const listed = typeof model === "string" ? undefined : model.efforts;
  const id = typeof model === "string" ? model : model.id;
  const levels = listed ?? knownEfforts(protocol, id) ?? PROTOCOL_EFFORTS[protocol];
  return ["default", ...EFFORT_ORDER.filter((e) => levels.includes(e) && PROTOCOL_EFFORTS[protocol].includes(e))];
}

/** The level as the protocol sends it: undefined for "default" and for levels the protocol does not have. */
export function protocolEffort(protocol: AiProtocol, effort: AiEffort): Exclude<AiEffort, "default"> | undefined {
  return effort !== "default" && PROTOCOL_EFFORTS[protocol].includes(effort) ? effort : undefined;
}

/** Gemini's thinkingConfig for a level: a budget on 2.5, a level on 3 and later; undefined for Default. */
export function geminiThinking(model: string, effort: AiEffort): { thinkingBudget: number } | { thinkingLevel: string } | undefined {
  const level = protocolEffort("gemini", effort);
  if (!level) return undefined;
  if (geminiUsesBudget(model)) {
    const pro = /2\.5-pro/.test(model.toLowerCase());
    const budget: Record<typeof level, number> = { none: pro ? 128 : 0, minimal: 512, low: 1024, medium: 8192, high: pro ? 32768 : 24576, xhigh: 24576, max: 24576 };
    return { thinkingBudget: budget[level] };
  }
  return { thinkingLevel: level === "none" ? "minimal" : level };
}

// ── Profiles ───────────────────────────────────────────────────────────────

/** A generated name: the provider (or the server's host) and the model. */
export function profileLabel(protocol: AiProtocol, baseUrl: string, model: string): string {
  const standard = originOf(baseUrl) === originOf(DEFAULT_BASE_URL[protocol]);
  const who = protocol === "openai" ? (standard ? "OpenAI" : hostOf(baseUrl))
    : protocol === "anthropic" ? (standard ? "Anthropic" : hostOf(baseUrl))
    : (standard ? "Gemini" : hostOf(baseUrl));
  return `${who} · ${model}`;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** linyra.ai.profiles as written: malformed entries are skipped, duplicate ids keep the first. */
export function parseProfiles(raw: unknown): AiProfile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AiProfile[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry as Record<string, unknown>;
    if (typeof p.id !== "string" || !p.id.trim() || seen.has(p.id) || !isProtocol(p.protocol) || typeof p.model !== "string" || typeof p.baseUrl !== "string") continue;
    const checked = checkBaseUrl(p.baseUrl);
    if (!("url" in checked)) continue;
    seen.add(p.id);
    out.push({
      id: p.id, protocol: p.protocol, baseUrl: checked.url, model: p.model.trim(), effort: isEffort(p.effort) ? p.effort : "default",
      label: typeof p.label === "string" && p.label.trim() ? p.label.trim() : profileLabel(p.protocol, checked.url, p.model.trim()),
    });
  }
  return out;
}

/** The profile in use: the active id, else the only one. */
export function activeProfile(profiles: readonly AiProfile[], activeId: unknown): AiProfile | undefined {
  return profiles.find((p) => p.id === activeId) ?? (profiles.length === 1 ? profiles[0] : undefined);
}

export function newProfileId(existing: readonly string[], random: () => number = Math.random): string {
  for (;;) {
    const id = `ai-${Math.floor(random() * 0x1000000).toString(36).padStart(5, "0")}`;
    if (!existing.includes(id)) return id;
  }
}

/** The saved profile the same connection would update (same protocol, address and model). */
export function sameConnection(profiles: readonly AiProfile[], p: Pick<AiProfile, "protocol" | "baseUrl" | "model">): AiProfile | undefined {
  return profiles.find((q) => q.protocol === p.protocol && q.baseUrl === p.baseUrl && q.model === p.model);
}

/** Adds the profile, or replaces the one with its id (in place, so the list keeps its order). */
export function upsertProfile(profiles: readonly AiProfile[], profile: AiProfile): AiProfile[] {
  const i = profiles.findIndex((p) => p.id === profile.id);
  return i < 0 ? [...profiles, profile] : profiles.map((p, j) => (j === i ? profile : p));
}

/** A model or level change; a generated label follows the new model, a label the user wrote stays. */
export function withModel(profile: AiProfile, model: string, effort: AiEffort): AiProfile {
  const generated = profile.label === profileLabel(profile.protocol, profile.baseUrl, profile.model);
  return { ...profile, model, effort, label: generated ? profileLabel(profile.protocol, profile.baseUrl, model) : profile.label };
}

/** The active id once `removed` are gone: kept if it survives, else the first remaining. */
export function activeAfterRemoval(profiles: readonly AiProfile[], activeId: string | undefined, removed: readonly string[]): string | undefined {
  const left = profiles.filter((p) => !removed.includes(p.id));
  return left.some((p) => p.id === activeId) ? activeId : left[0]?.id;
}

/** The secret saved for a profile: the key and the origin it was entered for. */
export interface SavedKey { key: string; origin: string }

export const secretName = (profileId: string): string => `linyra.ai.key.${profileId}`;

export function parseSavedKey(value: string | undefined): SavedKey | undefined {
  if (!value) return undefined;
  try {
    const v = JSON.parse(value) as Partial<SavedKey>;
    return typeof v.key === "string" && typeof v.origin === "string" ? { key: v.key, origin: v.origin } : undefined;
  } catch {
    return undefined;
  }
}

// ── Prompt size ────────────────────────────────────────────────────────────

/** Characters a request sends: system, every turn, tool results and tool schemas. */
export function requestChars(request: Pick<AiRequest, "system" | "turns" | "tools">): number {
  let n = request.system.length;
  for (const t of request.turns) {
    if (t.role === "tool") for (const r of t.results) n += r.output.length + r.name.length;
    else {
      n += t.content.length;
      if (t.role === "assistant") for (const c of t.toolCalls ?? []) n += c.name.length + JSON.stringify(c.input ?? null).length;
    }
  }
  for (const tool of request.tools ?? []) n += tool.name.length + tool.description.length + JSON.stringify(tool.parameters).length;
  return n;
}

/** The rough estimate linyra.ai.maxPromptTokens is compared with: characters ÷ 4. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / 4);

/** Over the limit (0 or less: never). */
export const overLimit = (tokens: number, limit: number): boolean => limit > 0 && tokens > limit;

/** A JSON answer without the code fence a model may put around it. */
export function jsonText(text: string): string {
  const m = /^\s*```(?:json|JSON)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return (m ? m[1] : text).trim();
}

/** The sentence a JSON request adds to the system prompt (OpenAI's json_object mode needs the word in the messages). */
export function withJsonInstruction(system: string): string {
  const sentence = "Reply with one JSON object and nothing else: no prose, no code fence.";
  return system.includes(sentence) ? system : system ? `${system}\n\n${sentence}` : sentence;
}

// ── Exclude globs ──────────────────────────────────────────────────────────

export const DEFAULT_EXCLUDE: readonly string[] = [
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "*.lock", "bun.lockb", "go.sum",
  "*.min.*", "dist/", "out/", "build/", "node_modules/", ".env*", "*.pem", "*.key",
];

function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; out += "(?:.*/)?"; } else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/**
 * One exclude glob as a test of a repository-relative path (forward slashes): `name` and `*.ext`
 * match at any depth, `dir/` a folder at any depth, a pattern with `/` from the repository root,
 * `**` any number of folders. Matching ignores case on Windows and macOS file systems.
 */
export function globMatcher(glob: string, ignoreCase = true): ((path: string) => boolean) | undefined {
  let g = glob.trim().replace(/\\/g, "/");
  if (!g || g.startsWith("#")) return undefined;
  const dir = g.endsWith("/");
  g = g.replace(/\/+$/, "");
  const anchored = g.includes("/");
  g = g.replace(/^\/+/, "");
  if (!g) return undefined;
  const flags = ignoreCase ? "i" : "";
  const body = globSource(g);
  const re = dir
    ? new RegExp(`${anchored ? "^" : "(?:^|/)"}${body}/`, flags)
    : new RegExp(`${anchored ? "^" : "(?:^|/)"}${body}(?:/|$)`, flags);
  return (path) => re.test(path.replace(/\\/g, "/").replace(/^\.?\/+/, ""));
}

/** Whether linyra.ai.exclude leaves this file out of every prompt. */
export function excludedBy(globs: readonly string[], path: string, ignoreCase = true): boolean {
  return globs.some((g) => globMatcher(g, ignoreCase)?.(path) ?? false);
}
