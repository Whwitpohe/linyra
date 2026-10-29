import * as assert from "assert";
import { configureI18n } from "../../i18n";
import { AiError, type AiProfile, type AiRequest } from "../types";
import { openAiBody, openAiModels, openAiProvider } from "./openai";

configureI18n("en");

interface Seen { url: string; init: RequestInit; body: Record<string, unknown> }

/** A fetch that records the request and answers with the given chunks as an event stream (split as given). */
function mockFetch(answer: (seen: Seen) => Response): { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input, init = {}) => {
      const s = { url: String(input), init, body: typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {} };
      seen.push(s);
      return answer(s);
    },
  };
}

const sse = (chunks: string[], status = 200) => new Response(new ReadableStream<Uint8Array>({
  start(c) {
    for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
    c.close();
  },
}), { status, headers: { "content-type": "text/event-stream" } });

const profile: AiProfile = { id: "p", label: "OpenAI · gpt-5.2", protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5.2", effort: "high" };
const local: AiProfile = { ...profile, baseUrl: "http://localhost:11434/v1", model: "llama3.2", effort: "default" };
const signal = new AbortController().signal;
const tool = { name: "filter_log", description: "Filter the Log", parameters: { type: "object" as const, properties: { author: { type: "string" } }, required: ["author"], additionalProperties: false as const } };

(async () => {
  {
    const request: AiRequest = {
      system: "You are Linyra.", signal, json: true, maxTokens: 500, tools: [tool],
      turns: [
        { role: "user", content: "Show commits by dana" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "filter_log", input: { author: "dana" } }], raw: { tool_calls: [{ id: "call_1", type: "function", function: { name: "filter_log", arguments: '{"author": "dana"}' } }] } },
        { role: "tool", results: [{ id: "call_1", name: "filter_log", output: "12 commits" }, { id: "call_2", name: "filter_log", output: "no such author", isError: true }] },
      ],
    };
    const body = openAiBody(profile, request);
    const messages = body.messages as Record<string, unknown>[];
    assert.strictEqual(messages[0].role, "system");
    assert.ok(/JSON/.test(String(messages[0].content)), "json_object mode needs the word JSON in the messages");
    assert.deepStrictEqual(messages[2], { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "filter_log", arguments: '{"author": "dana"}' } }] }, "raw tool calls go back unchanged");
    assert.deepStrictEqual(messages.slice(3), [{ role: "tool", tool_call_id: "call_1", content: "12 commits" }, { role: "tool", tool_call_id: "call_2", content: "Error: no such author" }]);
    assert.deepStrictEqual(body.tools, [{ type: "function", function: { name: "filter_log", description: "Filter the Log", parameters: tool.parameters } }]);
    assert.deepStrictEqual(body.response_format, { type: "json_object" });
    assert.strictEqual(body.reasoning_effort, "high");
    assert.strictEqual(body.max_completion_tokens, 500);
    assert.strictEqual(body.stream, true);
    for (const k of ["temperature", "top_p", "max_tokens"]) assert.ok(!(k in body), `no ${k}`);
    const plain = openAiBody(local, { system: "", turns: [{ role: "user", content: "hi" }], signal, maxTokens: 50 });
    assert.ok(!("reasoning_effort" in plain), "Default sends no reasoning_effort");
    assert.ok(!("stream_options" in plain) && plain.max_tokens === 50, "other servers get max_tokens and no stream_options");
    assert.deepStrictEqual(plain.messages, [{ role: "user", content: "hi" }], "no empty system message");
    assert.strictEqual(openAiBody({ ...local, effort: "max" }, { system: "", turns: [], signal }).reasoning_effort, undefined, "a level the protocol lacks is left out");
    console.log("ok - OpenAI: request mapping for system, turns, raw tool calls, results, tools, JSON mode, effort and limits");
  }

  {
    const chunks = [
      'data: {"model":"gpt-5.2","choices":[{"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"filter_log","arguments":"{\\"au"}}]}}]}\n',
      '\ndata: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"thor\\":\\"rin\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\ndata: [DONE]\n\n',
    ];
    const { fetch, seen } = mockFetch(() => sse(chunks));
    const deltas: string[] = [];
    const response = await openAiProvider(fetch).send(profile, "test-key", { system: "s", turns: [{ role: "user", content: "q" }], tools: [tool], signal, onText: (d) => deltas.push(d) });
    assert.strictEqual(seen[0].url, "https://api.openai.com/v1/chat/completions");
    assert.strictEqual(new Headers(seen[0].init.headers).get("authorization"), "Bearer test-key");
    assert.deepStrictEqual(deltas, ["Hel", "lo"]);
    assert.strictEqual(response.text, "Hello");
    assert.strictEqual(response.stop, "tool");
    assert.deepStrictEqual(response.toolCalls, [{ id: "call_9", name: "filter_log", input: { author: "rin" } }]);
    assert.deepStrictEqual(response.usage, { inputTokens: 11, outputTokens: 7 });
    assert.strictEqual(response.model, "gpt-5.2");
    // The round trip: the answer's raw goes into the next request unchanged.
    const next = openAiBody(profile, { system: "s", signal, turns: [{ role: "user", content: "q" }, { role: "assistant", content: response.text, toolCalls: response.toolCalls, raw: response.raw }, { role: "tool", results: [{ id: "call_9", name: "filter_log", output: "3 commits" }] }] });
    const messages = next.messages as Record<string, unknown>[];
    assert.deepStrictEqual(messages[2], { role: "assistant", content: "Hello", tool_calls: [{ id: "call_9", type: "function", function: { name: "filter_log", arguments: '{"author":"rin"}' } }] });
    assert.strictEqual(messages[3].tool_call_id, "call_9");
    console.log("ok - OpenAI: SSE text deltas, tool-call arguments across chunks, usage, [DONE], and the raw round trip");
  }

  {
    const { fetch, seen } = mockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: "whole" }, finish_reason: "length" }] }), { headers: { "content-type": "application/json" } }));
    const r = await openAiProvider(fetch).send(local, undefined, { system: "", turns: [{ role: "user", content: "q" }], signal });
    assert.deepStrictEqual([r.text, r.stop], ["whole", "length"], "a server that ignores stream: true");
    assert.strictEqual(new Headers(seen[0].init.headers).get("authorization"), null, "no key: no Authorization header");
    const refused = await openAiProvider(mockFetch(() => sse(['data: {"choices":[{"delta":{"refusal":"I can\'t"},"finish_reason":"stop"}]}\n\n'])).fetch)
      .send(profile, "k", { system: "", turns: [{ role: "user", content: "q" }], signal });
    assert.strictEqual(refused.stop, "refusal");
    const filtered = await openAiProvider(mockFetch(() => sse(['data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n'])).fetch)
      .send(profile, "k", { system: "", turns: [{ role: "user", content: "q" }], signal });
    assert.strictEqual(filtered.stop, "refusal");
    const bad = await openAiProvider(mockFetch(() => sse(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"x","arguments":"{oops"}}]}}]}\n\n'])).fetch)
      .send(profile, "k", { system: "", turns: [{ role: "user", content: "q" }], signal });
    assert.strictEqual(bad.toolCalls[0].input, "{oops", "arguments that are not JSON reach the feature's validation as text");
    console.log("ok - OpenAI: a non-streamed answer, refusals, content filter, malformed tool arguments");
  }

  {
    const fails = async (res: () => Response, kind: AiError["kind"], text?: RegExp) => {
      await assert.rejects(openAiProvider(mockFetch(res).fetch).send(profile, "bad-key", { system: "", turns: [{ role: "user", content: "q" }], signal }),
        (e: unknown) => e instanceof AiError && e.kind === kind && (!text || text.test(e.message)));
    };
    await fails(() => new Response('{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}', { status: 401 }), "auth", /Incorrect API key/);
    await fails(() => new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 }), "rateLimit", /Rate limit reached/);
    await fails(() => new Response("<html><body>Proxy sign-in</body></html>", { status: 403, headers: { "content-type": "text/html" } }), "auth", /web page/);
    await fails(() => new Response('{"error":{"message":"model not found"}}', { status: 404 }), "badRequest", /model not found/);
    await fails(() => sse(['data: {"choices":[{"delta":{"content":"par"}}]}\n\n', 'data: {"error":{"message":"Server overloaded","code":503}}\n\n']), "server", /Server overloaded/);
    await fails(() => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }), "network", /web page/);
    const errorFetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }); };
    await assert.rejects(openAiProvider(errorFetch).send(local, undefined, { system: "", turns: [], signal }), (e: unknown) => e instanceof AiError && e.kind === "network" && e.message.includes("localhost:11434"));
    const cancel = new AbortController();
    const slow = async (_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const pending = openAiProvider(slow).send(profile, "k", { system: "", turns: [], signal: cancel.signal });
    cancel.abort();
    await assert.rejects(pending, (e: unknown) => e instanceof AiError && e.kind === "cancelled");
    console.log("ok - OpenAI: 401, 429, a proxy's web page, 404, an error inside the stream, refused connection and cancel map to AiError");
  }

  {
    const listed = openAiModels({ data: [{ id: "gpt-5.2" }, { id: "text-embedding-3-small" }, { id: "o4-mini" }, { id: "whisper-1" }, { id: "gpt-4.1" }] }, profile.baseUrl);
    assert.deepStrictEqual(listed.map((m) => m.id), ["gpt-4.1", "gpt-5.2", "o4-mini"], "first-party: chat models only, sorted");
    assert.deepStrictEqual(listed.find((m) => m.id === "gpt-4.1")?.efforts, []);
    const ollama = openAiModels({ object: "list", data: [{ id: "qwen3:8b" }, { id: "nomic-embed-text" }] }, local.baseUrl);
    assert.deepStrictEqual(ollama.map((m) => [m.id, m.efforts]), [["nomic-embed-text", undefined], ["qwen3:8b", undefined]], "another server's list is kept whole; its levels are unknown");
    const router = openAiModels({ data: [{ id: "vendor/model-a", name: "Model A", context_length: 200000, supported_parameters: ["tools"] }] }, "https://gateway.example.com/v1");
    assert.deepStrictEqual(router[0], { id: "vendor/model-a", label: "Model A", contextTokens: 200000, efforts: [] });
    const { fetch, seen } = mockFetch(() => new Response(JSON.stringify({ data: [{ id: "llama3.2" }] }), { headers: { "content-type": "application/json" } }));
    assert.deepStrictEqual((await openAiProvider(fetch).listModels(local, "k", signal)).map((m) => m.id), ["llama3.2"]);
    assert.strictEqual(seen[0].url, "http://localhost:11434/v1/models");
    console.log("ok - OpenAI: model lists from OpenAI, Ollama and gateways, with context and known levels");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
