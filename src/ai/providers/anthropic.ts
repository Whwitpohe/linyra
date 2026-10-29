// Anthropic through the official SDK (@anthropic-ai/sdk): client.models.list() for the model
// list, client.messages.stream() + finalMessage() for answers. Thinking is adaptive on the models
// that take it, depth is output_config.effort (left out for "default"); no budget_tokens and no
// sampling parameters. A tool loop sends the assistant's content back unchanged (raw). On
// api.anthropic.com the models that support it opt into server-side fallback (fallbacks:
// "default"). The SDK is loaded the first time Anthropic is used, not at activation.
// No vscode import (fetch is injected; the tests give the SDK a mock fetch).
import { AiTimeout, asAiError, httpError, isHtml, networkError, providerDetail, timeoutError } from "../errors";
import { linkedSignal } from "../net";
import { anthropicAdaptive, anthropicFallbacks, FALLBACK_BETA, knownEfforts, protocolEffort, withJsonInstruction } from "../profileModel";
import { AiError, type AiEffort, type AiModel, type AiProfile, type AiProvider, type AiRequest, type AiResponse, type AiStop, type AiToolCall } from "../types";
import { HEADERS_TIMEOUT_MS, isObject, joinUrl, LIST_TIMEOUT_MS, num, str, type FetchLike } from "./http";

const load = () => import("@anthropic-ai/sdk");
type Sdk = Awaited<ReturnType<typeof load>>;
type AnthropicClient = InstanceType<Sdk["default"]>;
type Block = Record<string, unknown> & { type?: unknown };

let loaded: Promise<Sdk> | undefined;
/** The SDK module, evaluated on first use (esbuild keeps a dynamic import's module lazy). */
const sdk = (): Promise<Sdk> => (loaded ??= load());

/** The SDK appends /v1/…; an address typed with /v1 would double it. */
export const anthropicRoot = (baseUrl: string): string => baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");

function client(mod: Sdk, profile: AiProfile, apiKey: string | undefined, fetch: FetchLike): AnthropicClient {
  return new mod.default({
    // The key typed in Configure AI… and nothing else: a passed key keeps the SDK from reading
    // ANTHROPIC_* variables or credential files. A keyless local server gets no Authorization header.
    apiKey: apiKey || "none",
    ...(apiKey ? {} : { defaultHeaders: { authorization: null } }),
    baseURL: anthropicRoot(profile.baseUrl),
    fetch,
    timeout: HEADERS_TIMEOUT_MS,
    maxRetries: 2,
    openTelemetry: false,
    logLevel: "off",
  });
}

/** Default answer length: room for adaptive thinking on current models, a safe cap on older ones. */
export const anthropicMaxTokens = (model: string): number => (anthropicAdaptive(model) ? 64_000 : 8_192);

const RESULT = /_tool_result$/;
const lastFallback = (blocks: readonly Block[]): number => {
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].type === "fallback") return i;
  return -1;
};

/**
 * An answer's content as the next request sends it back: unchanged after the last fallback
 * boundary; before it only text and paired server-tool blocks (the declined model's thinking and
 * tool calls are dropped, as the fallback rules require); the fallback markers themselves dropped.
 */
export function replayContent(content: readonly unknown[]): Block[] {
  const blocks = content.filter((b): b is Block => isObject(b));
  const boundary = lastFallback(blocks);
  const resultIds = new Set(blocks.filter((b) => typeof b.type === "string" && RESULT.test(b.type)).map((b) => b.tool_use_id));
  return blocks.filter((b, i) => {
    if (b.type === "fallback") return false;
    if (i > boundary) return true;
    if (b.type === "text") return true;
    if (b.type === "server_tool_use") return resultIds.has(b.id);
    return typeof b.type === "string" && RESULT.test(b.type);
  });
}

/** The Messages request for a profile and request; `beta` when it opts into server-side fallback. */
export function anthropicParams(profile: AiProfile, request: AiRequest): { params: Record<string, unknown>; beta: boolean } {
  const messages: { role: "user" | "assistant"; content: unknown }[] = [];
  for (const turn of request.turns) {
    if (turn.role === "user") messages.push({ role: "user", content: turn.content });
    else if (turn.role === "assistant") {
      const content = Array.isArray(turn.raw) ? replayContent(turn.raw)
        : [
          ...(turn.content ? [{ type: "text", text: turn.content }] : []),
          ...(turn.toolCalls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: isObject(c.input) ? c.input : {} })),
        ];
      if (content.length > 0) messages.push({ role: "assistant", content });
    } else {
      // Every result of a step in one user message (separate messages teach the model to stop calling in parallel).
      messages.push({ role: "user", content: turn.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.output, ...(r.isError ? { is_error: true } : {}) })) });
    }
  }
  const system = request.json ? withJsonInstruction(request.system) : request.system;
  const params: Record<string, unknown> = {
    model: profile.model,
    max_tokens: request.maxTokens ?? anthropicMaxTokens(profile.model),
    messages,
  };
  // The stable prefix (tools, then system) is cached.
  if (system) params.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
  if (request.tools?.length) params.tools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (anthropicAdaptive(profile.model)) params.thinking = { type: "adaptive" };
  const effort = protocolEffort("anthropic", profile.effort);
  if (effort) params.output_config = { effort };
  const beta = anthropicFallbacks(profile);
  if (beta) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = "default";
  }
  return { params, beta };
}

const STOPS: Record<string, AiStop> = { end_turn: "end", stop_sequence: "end", pause_turn: "end", tool_use: "tool", max_tokens: "length", model_context_window_exceeded: "length", refusal: "refusal" };

/** A final message as an AiResponse. Tool calls are the ones after the last fallback boundary. */
export function anthropicAnswer(message: unknown): AiResponse {
  const m = isObject(message) ? message : {};
  const blocks = (Array.isArray(m.content) ? m.content : []).filter((b): b is Block => isObject(b));
  const boundary = lastFallback(blocks);
  const text = blocks.filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("");
  const toolCalls: AiToolCall[] = blocks.slice(boundary + 1).filter((b) => b.type === "tool_use")
    .map((b) => ({ id: str(b.id) ?? "", name: str(b.name) ?? "", input: b.input ?? {} }));
  const reason = str(m.stop_reason) ?? "end_turn";
  const stop: AiStop = STOPS[reason] ?? (toolCalls.length > 0 ? "tool" : "end");
  const u = isObject(m.usage) ? m.usage : {};
  const input = (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
  return {
    text, toolCalls, stop, raw: replayContent(blocks),
    usage: { inputTokens: input || undefined, outputTokens: num(u.output_tokens) },
    model: str(m.model),
  };
}

const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** A Models API entry; the effort levels come from its capabilities (the id table when a gateway leaves them out). */
export function anthropicModel(info: unknown): AiModel | undefined {
  if (!isObject(info) || !str(info.id) || info.lifecycle === "retired") return undefined;
  const id = str(info.id)!;
  const caps = isObject(info.capabilities) ? info.capabilities : undefined;
  const effort = caps && isObject(caps.effort) ? caps.effort : undefined;
  const supported = (v: unknown) => isObject(v) && v.supported === true;
  const efforts: AiEffort[] | undefined = effort ? (effort.supported === true ? LEVELS.filter((l) => supported(effort[l])) : []) : knownEfforts("anthropic", id);
  return { id, label: str(info.display_name), contextTokens: num(info.max_input_tokens), efforts };
}

/** SDK errors, most specific class first, as AiErrors. */
function sdkError(mod: Sdk, error: unknown, signal: AbortSignal, url: string): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof mod.APIUserAbortError) return asAiError(error, signal, url);
  if (error instanceof mod.APIConnectionTimeoutError) return timeoutError(url, Math.round(HEADERS_TIMEOUT_MS / 1000));
  if (error instanceof mod.APIConnectionError) return signal.aborted ? asAiError(error, signal, url) : networkError(error.cause ?? error, url);
  if (error instanceof mod.APIError) {
    const body = error.error as unknown;
    const raw = typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body);
    const detail = providerDetail(raw);
    const html = typeof body === "string" && isHtml(body);
    const status = error instanceof mod.AuthenticationError ? 401
      : error instanceof mod.PermissionDeniedError ? 403
      : error instanceof mod.NotFoundError ? 404
      : error instanceof mod.RateLimitError ? 429
      : error instanceof mod.BadRequestError ? 400
      : error instanceof mod.UnprocessableEntityError ? 422
      : error instanceof mod.InternalServerError ? (error.status ?? 500)
      : error.status;
    if (typeof status === "number") return httpError(status, detail, html);
    // An error event inside the stream: no status, only its type.
    switch (error.type) {
      case "rate_limit_error": return httpError(429, detail);
      case "overloaded_error": return httpError(529, detail);
      case "authentication_error": return httpError(401, detail);
      case "permission_error": return httpError(403, detail);
      case "invalid_request_error": return httpError(400, detail);
      default: return httpError(500, detail);
    }
  }
  return asAiError(error, signal, url);
}

interface Streaming { on(event: "text", listener: (delta: string) => void): unknown; finalMessage(): Promise<unknown> }

export function anthropicProvider(fetch: FetchLike): AiProvider {
  return {
    protocol: "anthropic",
    async listModels(profile, apiKey, signal) {
      const mod = await sdk();
      const url = joinUrl(anthropicRoot(profile.baseUrl), "v1/models");
      const link = linkedSignal(signal, () => new AiTimeout(Math.round(LIST_TIMEOUT_MS / 1000)));
      link.arm(LIST_TIMEOUT_MS);
      try {
        const out: AiModel[] = [];
        for await (const info of client(mod, profile, apiKey, fetch).models.list({ limit: 100 }, { signal: link.signal })) {
          const model = anthropicModel(info);
          if (model) out.push(model);
          if (out.length >= 1000) break;
        }
        return out;
      } catch (error) {
        throw sdkError(mod, error, link.signal, url);
      } finally {
        link.dispose();
      }
    },
    async send(profile, apiKey, request: AiRequest): Promise<AiResponse> {
      const mod = await sdk();
      const url = joinUrl(anthropicRoot(profile.baseUrl), "v1/messages");
      const c = client(mod, profile, apiKey, fetch);
      const { params, beta } = anthropicParams(profile, request);
      try {
        const stream: Streaming = beta
          ? c.beta.messages.stream(params as unknown as Parameters<typeof c.beta.messages.stream>[0], { signal: request.signal })
          : c.messages.stream(params as unknown as Parameters<typeof c.messages.stream>[0], { signal: request.signal });
        const onText = request.onText;
        if (onText) stream.on("text", (delta) => onText(delta));
        return anthropicAnswer(await stream.finalMessage());
      } catch (error) {
        throw sdkError(mod, error, request.signal, url);
      }
    },
  };
}
