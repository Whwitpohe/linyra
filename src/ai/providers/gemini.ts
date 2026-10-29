// Google Gemini (generateContent REST): GET {base}/models with x-goog-api-key,
// POST {base}/models/{model}:streamGenerateContent?alt=sse, tools as functionDeclarations,
// thinking as generationConfig.thinkingConfig (a budget on 2.5, a level on 3 and later). The
// model's parts are kept exactly as they came, thought signatures included, and sent back
// unchanged in a tool loop. Pure: no vscode import (fetch is injected).
import { localize } from "../../i18n";
import { asAiError } from "../errors";
import { geminiThinking, knownEfforts } from "../profileModel";
import { readSse } from "../sse";
import { AiError, type AiModel, type AiProfile, type AiProvider, type AiRequest, type AiResponse, type AiStop, type AiToolCall } from "../types";
import { call, getJson, HEADERS_TIMEOUT_MS, isObject, joinUrl, notJson, num, str, type FetchLike } from "./http";

type Part = Record<string, unknown>;

/** What a Gemini model turn keeps in `raw`: its parts as sent. */
export interface GeminiRaw { parts: Part[] }

/** Calls Gemini sent without an id get one of these; it is never sent back as an id. */
const SYNTHETIC = "gemini-call-";
/** Gemini's documented stand-in signature for a function call it did not produce (history from another provider). */
const SKIP_SIGNATURE = "skip_thought_signature_validator";
/** Answers Gemini blocked: a refusal, not an empty answer. */
const BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT"]);

const headersFor = (key: string | undefined): Record<string, string> => (key ? { "x-goog-api-key": key } : {});
const modelPath = (model: string) => model.replace(/^models\//, "");

export function geminiModels(body: unknown): { models: AiModel[]; next?: string } {
  const o = isObject(body) ? body : {};
  const models: AiModel[] = [];
  for (const m of Array.isArray(o.models) ? o.models : []) {
    if (!isObject(m)) continue;
    const id = modelPath(str(m.name) ?? "");
    const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : undefined;
    if (!id || (methods && !methods.includes("generateContent"))) continue;
    models.push({ id, label: str(m.displayName), contextTokens: num(m.inputTokenLimit), efforts: m.thinking === false ? [] : knownEfforts("gemini", id) });
  }
  return { models, next: str(o.nextPageToken) || undefined };
}

/** JSON Schema as Gemini's OpenAPI-subset Schema reads it: keywords it rejects are dropped. */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!isObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" || key === "$schema" || key === "$id" || key === "strict") continue;
    out[key] = key === "properties" && isObject(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, geminiSchema(v)])) : geminiSchema(value);
  }
  return out;
}

/** The generateContent request body for a profile and request. */
export function geminiBody(profile: AiProfile, request: AiRequest): Record<string, unknown> {
  const contents: { role: "user" | "model"; parts: Part[] }[] = [];
  for (const turn of request.turns) {
    if (turn.role === "user") contents.push({ role: "user", parts: [{ text: turn.content }] });
    else if (turn.role === "assistant") {
      const raw = turn.raw as Partial<GeminiRaw> | undefined;
      if (Array.isArray(raw?.parts) && raw.parts.length > 0) {
        contents.push({ role: "model", parts: raw.parts });
        continue;
      }
      const parts: Part[] = turn.content ? [{ text: turn.content }] : [];
      (turn.toolCalls ?? []).forEach((c, i) => {
        const fc: Record<string, unknown> = { name: c.name, args: isObject(c.input) ? c.input : {} };
        if (!c.id.startsWith(SYNTHETIC)) fc.id = c.id;
        parts.push(i === 0 ? { functionCall: fc, thoughtSignature: SKIP_SIGNATURE } : { functionCall: fc });
      });
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else {
      // Every answer of a step goes in one content, in the order the calls came.
      contents.push({
        role: "user",
        parts: turn.results.map((r) => {
          const fr: Record<string, unknown> = { name: r.name, response: r.isError ? { error: r.output } : { result: r.output } };
          if (!r.id.startsWith(SYNTHETIC)) fr.id = r.id;
          return { functionResponse: fr };
        }),
      });
    }
  }
  const body: Record<string, unknown> = { contents };
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
  if (request.tools?.length) {
    body.tools = [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
  }
  const config: Record<string, unknown> = {};
  if (request.maxTokens) config.maxOutputTokens = request.maxTokens;
  if (request.json) config.responseMimeType = "application/json";
  const thinking = geminiThinking(profile.model, profile.effort);
  if (thinking) config.thinkingConfig = thinking;
  if (Object.keys(config).length > 0) body.generationConfig = config;
  return body;
}

interface Accumulated { text: string; parts: Part[]; finish?: string; blocked?: string; usage?: AiResponse["usage"]; model?: string }

/** A streamed part into the kept parts: text runs join, but never into or out of a part that carries a signature. */
function keep(parts: Part[], part: Part): void {
  const last = parts.at(-1);
  const plain = (p: Part) => typeof p.text === "string" && p.thoughtSignature === undefined && Object.keys(p).every((k) => k === "text" || k === "thought");
  if (last && plain(last) && plain(part) && !!last.thought === !!part.thought) last.text = `${last.text as string}${part.text as string}`;
  else parts.push({ ...part });
}

function fold(acc: Accumulated, chunk: Record<string, unknown>, onText: AiRequest["onText"]): void {
  if (isObject(chunk.error)) {
    const message = str(chunk.error.message) ?? localize("The provider stopped with an error.");
    throw new AiError(localize("The provider stopped with an error: {0}", message), num(chunk.error.code) === 429 ? "rateLimit" : "server");
  }
  acc.model = str(chunk.modelVersion) ?? acc.model;
  if (isObject(chunk.usageMetadata)) {
    const u = chunk.usageMetadata;
    acc.usage = { inputTokens: num(u.promptTokenCount), outputTokens: (num(u.candidatesTokenCount) ?? 0) + (num(u.thoughtsTokenCount) ?? 0) || undefined };
  }
  if (isObject(chunk.promptFeedback) && str(chunk.promptFeedback.blockReason)) acc.blocked = str(chunk.promptFeedback.blockReason);
  const candidate = Array.isArray(chunk.candidates) && isObject(chunk.candidates[0]) ? chunk.candidates[0] : undefined;
  if (!candidate) return;
  const content = isObject(candidate.content) ? candidate.content : {};
  for (const part of Array.isArray(content.parts) ? content.parts : []) {
    if (!isObject(part)) continue;
    keep(acc.parts, part);
    const text = str(part.text);
    if (text && !part.thought) {
      acc.text += text;
      onText?.(text);
    }
  }
  const finish = str(candidate.finishReason);
  if (finish) acc.finish = finish;
}

function answer(acc: Accumulated): AiResponse {
  let n = 0;
  const toolCalls: AiToolCall[] = acc.parts.flatMap((p) => {
    if (!isObject(p.functionCall)) return [];
    const fc = p.functionCall;
    return [{ id: str(fc.id) ?? `${SYNTHETIC}${n++}`, name: str(fc.name) ?? "", input: isObject(fc.args) ? fc.args : {} }];
  });
  const stop: AiStop = acc.blocked || (acc.finish && BLOCKED.has(acc.finish)) ? "refusal"
    : toolCalls.length > 0 ? "tool"
    : acc.finish === "MAX_TOKENS" ? "length" : "end";
  return { text: acc.text, toolCalls, stop, raw: acc.parts.length > 0 ? ({ parts: acc.parts } satisfies GeminiRaw) : undefined, usage: acc.usage, model: acc.model };
}

export function geminiProvider(fetch: FetchLike): AiProvider {
  return {
    protocol: "gemini",
    async listModels(profile, apiKey, signal) {
      const out: AiModel[] = [];
      let page: string | undefined;
      for (let i = 0; i < 5; i++) {
        const url = joinUrl(profile.baseUrl, `models?pageSize=1000${page ? `&pageToken=${encodeURIComponent(page)}` : ""}`);
        const { models, next } = geminiModels(await getJson(fetch, url, headersFor(apiKey), signal));
        out.push(...models);
        if (!next) break;
        page = next;
      }
      return out;
    },
    async send(profile, apiKey, request) {
      const url = joinUrl(profile.baseUrl, `models/${modelPath(profile.model).split("/").map(encodeURIComponent).join("/")}:streamGenerateContent?alt=sse`);
      const init: RequestInit = { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", ...headersFor(apiKey) }, body: JSON.stringify(geminiBody(profile, request)) };
      const { res, signal, done } = await call(fetch, url, init, request.signal, { timeoutMs: HEADERS_TIMEOUT_MS, stream: true });
      const acc: Accumulated = { text: "", parts: [] };
      try {
        const type = res.headers.get("content-type") ?? "";
        if (!/event-stream/i.test(type)) {
          // A gateway that drops alt=sse answers with one JSON array of every chunk.
          const text = await res.text();
          let whole: unknown;
          try {
            whole = JSON.parse(text);
          } catch {
            throw notJson(text, type);
          }
          for (const c of Array.isArray(whole) ? whole : [whole]) if (isObject(c)) fold(acc, c, request.onText);
          return answer(acc);
        }
        for await (const event of readSse(res.body ?? new ReadableStream(), signal)) {
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
