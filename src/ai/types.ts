// Linyra's AI layer, provider-neutral: what the features (src/ai/features/*) ask of a model, and
// what each protocol adapter (src/ai/providers/*) must answer. Pure types: no vscode import.

/** The wire protocols Linyra speaks. "openai" covers every OpenAI-compatible server (Ollama, LM Studio, gateways). */
export type AiProtocol = "openai" | "anthropic" | "gemini";

/**
 * How hard the model thinks. "default" sends nothing and lets the model decide; each adapter maps
 * the rest onto its protocol (OpenAI reasoning_effort, Anthropic output_config.effort, Gemini
 * thinkingConfig) and leaves out a level the chosen model does not take.
 */
export type AiEffort = "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** A saved connection (settings: linyra.ai.profiles). The API key is never here: it lives in SecretStorage under `id`. */
export interface AiProfile {
  id: string;
  label: string;
  protocol: AiProtocol;
  /** The API root, e.g. https://api.openai.com/v1, https://api.anthropic.com, https://generativelanguage.googleapis.com/v1beta. */
  baseUrl: string;
  model: string;
  effort: AiEffort;
}

/** A model as a provider lists it (GET …/models). */
export interface AiModel {
  id: string;
  label?: string;
  /** Context window in tokens, when the provider says. */
  contextTokens?: number;
  /** Effort levels the model takes, when the provider says; undefined: unknown, every level offered. */
  efforts?: AiEffort[];
}

/** A function the model may call (Ask AI's Linyra actions). `parameters` is a JSON Schema object. */
export interface AiTool {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: false };
}

export interface AiToolCall { id: string; name: string; input: unknown }

export interface AiToolResult { id: string; name: string; output: string; isError?: boolean }

/**
 * One turn of a conversation. An assistant turn keeps `raw`, the provider's own content blocks:
 * a tool loop must send them back unchanged (Anthropic's thinking blocks, Gemini's thought
 * signatures), and only the adapter that produced them reads them.
 */
export type AiTurn =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: AiToolCall[]; raw?: unknown }
  | { role: "tool"; results: AiToolResult[] };

export interface AiRequest {
  /** Stable instructions first: providers cache the prefix. */
  system: string;
  turns: AiTurn[];
  tools?: AiTool[];
  /** Ask for one JSON object back (the adapter uses the protocol's JSON mode when it has one). */
  json?: boolean;
  /** Upper bound on the reply; the adapter picks a sensible default. */
  maxTokens?: number;
  /** Streams text as it arrives. */
  onText?: (delta: string) => void;
  signal: AbortSignal;
}

export type AiStop = "end" | "tool" | "length" | "refusal";

export interface AiResponse {
  text: string;
  toolCalls: AiToolCall[];
  stop: AiStop;
  /** Echo into the next request's assistant turn (see AiTurn). */
  raw?: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** The model that answered (a fallback may differ from the one asked). */
  model?: string;
}

/** A protocol adapter. Stateless: the service hands it the profile and key on every call. */
export interface AiProvider {
  readonly protocol: AiProtocol;
  listModels(profile: AiProfile, apiKey: string | undefined, signal: AbortSignal): Promise<AiModel[]>;
  send(profile: AiProfile, apiKey: string | undefined, request: AiRequest): Promise<AiResponse>;
}

/**
 * What every AI feature uses (src/ai/service.ts implements it; extension.ts registers it). Features
 * never see keys, URLs or protocols.
 */
export interface AiService {
  /** linyra.ai.enabled and a profile with a model. */
  readonly configured: boolean;
  readonly profile: AiProfile | undefined;
  /** Configured, or walk the user through Configure AI… now; false if they backed out. */
  ensureReady(): Promise<boolean>;
  /** One request to the active profile. Throws AiError. */
  ask(request: AiRequest): Promise<AiResponse>;
  /**
   * Shows a streamed Markdown answer in the editor area (a read-only preview titled `title`), with
   * a cancellable progress notification while `run` writes to it.
   */
  present(title: string, run: (write: (markdown: string) => void, signal: AbortSignal) => Promise<void>): Promise<void>;
  /** Files the prompts leave out (linyra.ai.exclude globs: lockfiles, minified and built files, secrets). */
  excluded(path: string): boolean;
}

/** Errors the features show as they are: no stack, no provider JSON. */
export class AiError extends Error {
  constructor(message: string, readonly kind: "notConfigured" | "auth" | "rateLimit" | "network" | "badRequest" | "refusal" | "cancelled" | "server" | "tooLarge") {
    super(message);
  }
}
