// OpenAI-compatible Chat Completions: OpenAI itself and every server that speaks its API (Ollama,
// LM Studio, vLLM, gateways). GET {base}/models, POST {base}/chat/completions streamed as SSE,
// tools as function calling, reasoning_effort only when a level is chosen, no temperature.
// Pure: no vscode import (fetch is injected).
import { localize } from "../../i18n";
import { asAiError } from "../errors";
import { isFirstPartyOpenAi, knownEfforts, protocolEffort, withJsonInstruction } from "../profileModel";
import { readSse } from "../sse";
import { AiError, type AiModel, type AiProfile, type AiProvider, type AiRequest, type AiResponse, type AiStop, type AiToolCall } from "../types";
import { call, getJson, HEADERS_TIMEOUT_MS, isObject, joinUrl, notJson, num, parseArguments, str, type FetchLike } from "./http";

/** A tool call as the server sent it, kept to echo back unchanged (its arguments text included). */
interface WireToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

/** What an OpenAI-compatible assistant turn keeps in `raw`. */
export interface OpenAiRaw { tool_calls: WireToolCall[] }

const headersFor = (key: string | undefined): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

/** Models OpenAI lists that cannot chat (embeddings, speech, images, moderation). Other servers list only what they serve. */
const NOT_CHAT = /(embedding|whisper|tts|dall-e|moderation|davinci|babbage|realtime|transcribe|audio|image|sora|search)/;

export function openAiModels(body: unknown, baseUrl: string): AiModel[] {
  const list = Array.isArray(body) ? body : isObject(body) ? (Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []) : [];
  const firstParty = isFirstPartyOpenAi(baseUrl);
  const out: AiModel[] = [];
  for (const m of list) {
    const id = isObject(m) ? str(m.id) ?? str(m.name) : str(m);
    if (!id || (firstParty && NOT_CHAT.test(id))) continue;
    const o = isObject(m) ? m : {};
    const contextTokens = num(o.context_length) ?? num(o.max_model_len) ?? num(o.context_window);
    // OpenRouter-style servers say which request fields a model takes.
    const params = Array.isArray(o.supported_parameters) ? o.supported_parameters : undefined;
    const efforts = params && !params.includes("reasoning") && !params.includes("reasoning_effort") ? [] : knownEfforts("openai", id);
    out.push({ id, label: str(o.name) !== id ? str(o.name) : undefined, contextTokens, efforts });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The Chat Completions request body for a profile and request. */
export function openAiBody(profile: AiProfile, request: AiRequest): Record<string, unknown> {
  const system = request.json ? withJsonInstruction(request.system) : request.system;
  const messages: Record<string, unknown>[] = [];
  if (system) messages.push({ role: "system", content: system });
  for (const turn of request.turns) {
    if (turn.role === "user") messages.push({ role: "user", content: turn.content });
    else if (turn.role === "assistant") {
      const raw = turn.raw as Partial<OpenAiRaw> | undefined;
      const toolCalls: WireToolCall[] = Array.isArray(raw?.tool_calls) ? raw.tool_calls
        : (turn.toolCalls ?? []).map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: typeof c.input === "string" ? c.input : JSON.stringify(c.input ?? {}) } }));
      messages.push(toolCalls.length > 0 ? { role: "assistant", content: turn.content || null, tool_calls: toolCalls } : { role: "assistant", content: turn.content });
    } else {
      for (const r of turn.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${r.output}` : r.output });
    }
  }
  const body: Record<string, unknown> = { model: profile.model, messages, stream: true };
  if (isFirstPartyOpenAi(profile.baseUrl)) body.stream_options = { include_usage: true };
  if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (request.json) body.response_format = { type: "json_object" };
  const effort = protocolEffort("openai", profile.effort);
  if (effort) body.reasoning_effort = effort;
  // OpenAI's reasoning models take only max_completion_tokens; other servers know max_tokens.
  if (request.maxTokens) body[isFirstPartyOpenAi(profile.baseUrl) ? "max_completion_tokens" : "max_tokens"] = request.maxTokens;
  return body;
}

interface Accumulated { text: string; refusal: string; finish?: string; calls: Map<number, { id: string; name: string; args: string }>; usage?: AiResponse["usage"]; model?: string }

function streamError(error: unknown): AiError {
  const e = isObject(error) ? error : {};
  const message = str(e.message) ?? localize("The provider stopped with an error.");
  const code = num(e.code) ?? num(e.status);
  const kind: AiError["kind"] = code === 429 || /rate.?limit|quota/i.test(message) ? "rateLimit" : code === 401 ? "auth" : code !== undefined && code < 500 ? "badRequest" : "server";
  return new AiError(localize("The provider stopped with an error: {0}", message), kind);
}

/** One chunk (or a whole non-streamed completion) folded into the answer so far. */
function fold(acc: Accumulated, chunk: Record<string, unknown>, onText: AiRequest["onText"]): void {
  if (chunk.error) throw streamError(chunk.error);
  acc.model ??= str(chunk.model);
  if (isObject(chunk.usage)) acc.usage = { inputTokens: num(chunk.usage.prompt_tokens), outputTokens: num(chunk.usage.completion_tokens) };
  const choice = Array.isArray(chunk.choices) && isObject(chunk.choices[0]) ? chunk.choices[0] : undefined;
  if (!choice) return;
  const delta = isObject(choice.delta) ? choice.delta : isObject(choice.message) ? choice.message : {};
  const text = str(delta.content);
  if (text) {
    acc.text += text;
    onText?.(text);
  }
  const refusal = str(delta.refusal);
  if (refusal) acc.refusal += refusal;
  if (Array.isArray(delta.tool_calls)) {
    delta.tool_calls.forEach((tc: unknown, position: number) => {
      if (!isObject(tc)) return;
      const index = num(tc.index) ?? position;
      const entry = acc.calls.get(index) ?? { id: "", name: "", args: "" };
      const fn = isObject(tc.function) ? tc.function : {};
      if (str(tc.id)) entry.id = str(tc.id)!;
      if (str(fn.name) && !entry.name) entry.name = str(fn.name)!;
      // Arguments stream as text; a few servers send the parsed object once.
      if (typeof fn.arguments === "string") entry.args += fn.arguments;
      else if (fn.arguments !== undefined) entry.args = JSON.stringify(fn.arguments);
      acc.calls.set(index, entry);
    });
  }
  const finish = str(choice.finish_reason);
  if (finish) acc.finish = finish;
}

function answer(acc: Accumulated): AiResponse {
  const wire: WireToolCall[] = [...acc.calls.entries()].sort(([a], [b]) => a - b)
    .map(([index, c]) => ({ id: c.id || `call_${index}`, type: "function", function: { name: c.name, arguments: c.args } }));
  const toolCalls: AiToolCall[] = wire.map((w) => ({ id: w.id, name: w.function.name, input: parseArguments(w.function.arguments) }));
  const stop: AiStop = acc.refusal || acc.finish === "content_filter" ? "refusal"
    : toolCalls.length > 0 ? "tool"
    : acc.finish === "length" ? "length" : "end";
  return { text: acc.text, toolCalls, stop, raw: wire.length > 0 ? ({ tool_calls: wire } satisfies OpenAiRaw) : undefined, usage: acc.usage, model: acc.model };
}

export function openAiProvider(fetch: FetchLike): AiProvider {
  return {
    protocol: "openai",
    async listModels(profile, apiKey, signal) {
      return openAiModels(await getJson(fetch, joinUrl(profile.baseUrl, "models"), headersFor(apiKey), signal), profile.baseUrl);
    },
    async send(profile, apiKey, request) {
      const url = joinUrl(profile.baseUrl, "chat/completions");
      const init: RequestInit = { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", ...headersFor(apiKey) }, body: JSON.stringify(openAiBody(profile, request)) };
      const { res, signal, done } = await call(fetch, url, init, request.signal, { timeoutMs: HEADERS_TIMEOUT_MS, stream: true });
      const acc: Accumulated = { text: "", refusal: "", calls: new Map() };
      try {
        const type = res.headers.get("content-type") ?? "";
        if (!/event-stream/i.test(type)) {
          // A server that ignores stream: true answers with the whole completion.
          const text = await res.text();
          let whole: unknown;
          try {
            whole = JSON.parse(text);
          } catch {
            throw notJson(text, type);
          }
          if (isObject(whole)) fold(acc, whole, request.onText);
          return answer(acc);
        }
        for await (const event of readSse(res.body ?? new ReadableStream(), signal)) {
          if (event.data.trim() === "[DONE]") break;
          let chunk: unknown;
          try {
            chunk = JSON.parse(event.data);
          } catch {
            continue;
          }
          if (isObject(chunk)) fold(acc, chunk, request.onText);
        }
        return answer(acc);
      } catch (error) {
        throw asAiError(error, signal, url);
      } finally {
        done();
      }
    },
  };
}
