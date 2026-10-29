// The Anthropic adapter runs the real SDK against a mock fetch: request mapping, the stream, the
// tool round trip with thinking blocks, fallbacks, refusals and errors. No real endpoint is called.
import * as assert from "assert";
import { configureI18n } from "../../i18n";
import { AiError, type AiProfile, type AiRequest } from "../types";
import { anthropicAnswer, anthropicModel, anthropicParams, anthropicProvider, anthropicRoot, replayContent } from "./anthropic";

configureI18n("en");

interface Seen { url: string; headers: Headers; body: Record<string, unknown> }

function mockFetch(answer: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: async (input: string | URL | Request, init: RequestInit = {}) => {
      const s = { url: String(input), headers: new Headers(init.headers), body: typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {} };
      seen.push(s);
      return answer(s);
    },
  };
}

const event = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const stream = (events: string[]) => new Response(new ReadableStream<Uint8Array>({
  start(c) {
    // Cut the stream mid-event, as a network would.
    const text = events.join("");
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += 37) c.enqueue(bytes.slice(i, i + 37));
    c.close();
  },
}), { headers: { "content-type": "text/event-stream", "request-id": "req_test" } });
const failure = (status: number, type: string, message: string) => new Response(JSON.stringify({ type: "error", error: { type, message } }),
  { status, headers: { "content-type": "application/json", "x-should-retry": "false" } });

const start = (model: string) => event("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 1 } } });
const block = (index: number, content_block: Record<string, unknown>) => event("content_block_start", { index, content_block });
const delta = (index: number, d: Record<string, unknown>) => event("content_block_delta", { index, delta: d });
const stop = (index: number) => event("content_block_stop", { index });
const end = (stop_reason: string, extra: Record<string, unknown> = {}) => event("message_delta", { delta: { stop_reason, stop_sequence: null, ...extra }, usage: { output_tokens: 40 } }) + event("message_stop", {});

const opus: AiProfile = { id: "a", label: "Anthropic · claude-opus-5-5", protocol: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5", effort: "high" };
const gateway: AiProfile = { ...opus, baseUrl: "https://gateway.example.com/anthropic/v1", effort: "default" };
const signal = new AbortController().signal;
const tool = { name: "filter_log", description: "Filter the Log", parameters: { type: "object" as const, properties: { author: { type: "string" } }, required: ["author"] } };

(async () => {
  {
    const { params, beta } = anthropicParams(opus, { system: "You are Linyra.", signal, json: true, tools: [tool], turns: [{ role: "user", content: "q" }] });
    assert.ok(beta);
    assert.deepStrictEqual(params.betas, ["server-side-fallback-2026-07-01"]);
    assert.strictEqual(params.fallbacks, "default");
    assert.deepStrictEqual(params.thinking, { type: "adaptive" });
    assert.deepStrictEqual(params.output_config, { effort: "high" });
    assert.strictEqual(params.max_tokens, 64000);
    const system = params.system as { text: string; cache_control: unknown }[];
    assert.ok(/JSON/.test(system[0].text) && system[0].text.startsWith("You are Linyra."));
    assert.deepStrictEqual(system[0].cache_control, { type: "ephemeral" });
    assert.deepStrictEqual(params.tools, [{ name: "filter_log", description: "Filter the Log", input_schema: tool.parameters }]);
    for (const k of ["temperature", "top_p", "top_k", "budget_tokens", "tool_choice"]) assert.ok(!(k in params) && !JSON.stringify(params).includes(`"${k}"`), `never ${k}`);
    const viaGateway = anthropicParams(gateway, { system: "", signal, turns: [{ role: "user", content: "q" }] });
    assert.ok(!viaGateway.beta && !("fallbacks" in viaGateway.params) && !("betas" in viaGateway.params), "no fallbacks on another address");
    assert.ok(!("output_config" in viaGateway.params), "Default sends no effort");
    assert.ok(!("system" in viaGateway.params));
    const old = anthropicParams({ ...opus, model: "claude-haiku-4-5", effort: "default" }, { system: "", signal, turns: [] });
    assert.ok(!("thinking" in old.params) && !old.beta && old.params.max_tokens === 8192, "an older model gets no adaptive thinking");
    assert.ok(!("output_config" in anthropicParams({ ...opus, effort: "minimal" }, { system: "", signal, turns: [] }).params), "a level Anthropic lacks is left out");
    assert.strictEqual(anthropicRoot("https://gateway.example.com/anthropic/v1/"), "https://gateway.example.com/anthropic");
    console.log("ok - Anthropic: adaptive thinking, output_config.effort, cached system, tools, fallbacks only on api.anthropic.com, no sampling or budget");
  }

  {
    const events = [
      start("claude-opus-5-5"),
      block(0, { type: "thinking", thinking: "", signature: "" }), delta(0, { type: "signature_delta", signature: "sig-thinking" }), stop(0),
      block(1, { type: "text", text: "" }), delta(1, { type: "text_delta", text: "Checking " }), delta(1, { type: "text_delta", text: "the Log." }), stop(1),
      block(2, { type: "tool_use", id: "toolu_1", name: "filter_log", input: {} }), delta(2, { type: "input_json_delta", partial_json: '{"author":' }), delta(2, { type: "input_json_delta", partial_json: '"rin"}' }), stop(2),
      end("tool_use"),
    ];
    const { fetch, seen } = mockFetch(() => stream(events));
    const deltas: string[] = [];
    const request: AiRequest = { system: "s", turns: [{ role: "user", content: "Commits by rin?" }], tools: [tool], signal, onText: (d) => deltas.push(d) };
    const r = await anthropicProvider(fetch).send(opus, "test-key", request);
    assert.ok(seen[0].url.startsWith("https://api.anthropic.com/v1/messages"));
    assert.strictEqual(seen[0].headers.get("anthropic-beta"), "server-side-fallback-2026-07-01");
    assert.strictEqual(seen[0].headers.get("authorization"), "Bearer test-key");
    assert.strictEqual(seen[0].body.fallbacks, "default");
    assert.strictEqual(seen[0].body.stream, true);
    assert.ok(!("betas" in seen[0].body), "the SDK sends betas as a header");
    assert.deepStrictEqual(deltas, ["Checking ", "the Log."]);
    assert.strictEqual(r.text, "Checking the Log.");
    assert.strictEqual(r.stop, "tool");
    assert.deepStrictEqual(r.toolCalls, [{ id: "toolu_1", name: "filter_log", input: { author: "rin" } }]);
    assert.deepStrictEqual(r.usage, { inputTokens: 15, outputTokens: 40 });
    assert.strictEqual(r.model, "claude-opus-5-5");
    // The round trip: the assistant's content (its thinking block and signature included) goes back unchanged.
    const raw = r.raw as Record<string, unknown>[];
    assert.deepStrictEqual(raw.map((b) => b.type), ["thinking", "text", "tool_use"]);
    assert.strictEqual(raw[0].signature, "sig-thinking");
    const second = mockFetch(() => stream([start("claude-opus-5-5"), block(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "rin made 3 commits." }), stop(0), end("end_turn")]));
    const done = await anthropicProvider(second.fetch).send(opus, "test-key", { ...request, turns: [
      ...request.turns,
      { role: "assistant", content: r.text, toolCalls: r.toolCalls, raw: r.raw },
      { role: "tool", results: [{ id: "toolu_1", name: "filter_log", output: "3 commits" }] },
    ] });
    const messages = second.seen[0].body.messages as { role: string; content: unknown }[];
    assert.deepStrictEqual(JSON.parse(JSON.stringify(messages[1].content)), JSON.parse(JSON.stringify(raw)), "raw replayed unchanged");
    assert.deepStrictEqual(messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "3 commits" }] });
    assert.deepStrictEqual([done.text, done.stop], ["rin made 3 commits.", "end"]);
    console.log("ok - Anthropic: the SDK streams text, tool input across deltas, usage; thinking blocks go back unchanged in the tool loop");
  }

  {
    // A mid-stream fallback: the declined model's tool call is before the boundary and never runs or goes back.
    const content = [
      { type: "thinking", thinking: "", signature: "declined" },
      { type: "text", text: "Partial " },
      { type: "tool_use", id: "toolu_old", name: "filter_log", input: { author: "x" } },
      { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" } },
      { type: "thinking", thinking: "", signature: "kept" },
      { type: "text", text: "answer." },
      { type: "tool_use", id: "toolu_new", name: "filter_log", input: { author: "dana" } },
    ];
    const r = anthropicAnswer({ model: "claude-opus-5", content, stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 2 } });
    assert.strictEqual(r.text, "Partial answer.");
    assert.deepStrictEqual(r.toolCalls.map((c) => c.id), ["toolu_new"]);
    assert.strictEqual(r.model, "claude-opus-5", "the model that answered");
    assert.deepStrictEqual((r.raw as { type: string; signature?: string; id?: string }[]).map((b) => b.signature ?? b.id ?? b.type), ["text", "kept", "text", "toolu_new"]);
    assert.deepStrictEqual(replayContent([{ type: "server_tool_use", id: "s1" }, { type: "web_search_tool_result", tool_use_id: "s1" }, { type: "server_tool_use", id: "s2" }, { type: "mystery" }, { type: "fallback" }, { type: "text", text: "t" }]).map((b) => b.type),
      ["server_tool_use", "web_search_tool_result", "text"], "before the boundary: paired server-tool blocks and text only");
    const refused = mockFetch(() => stream([start("claude-opus-5-5"), block(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "I" }), stop(0), end("refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } })]));
    const out = await anthropicProvider(refused.fetch).send(opus, "k", { system: "", turns: [{ role: "user", content: "q" }], signal });
    assert.strictEqual(out.stop, "refusal");
    console.log("ok - Anthropic: after a fallback only the serving model's tool calls count and go back; a refusal stops as refusal");
  }

  {
    const noKey = mockFetch(() => stream([start("local-model"), block(0, { type: "text", text: "" }), delta(0, { type: "text_delta", text: "hi" }), stop(0), end("max_tokens")]));
    const r = await anthropicProvider(noKey.fetch).send({ ...gateway, model: "local-model" }, undefined, { system: "", turns: [{ role: "user", content: "q" }], signal });
    assert.strictEqual(noKey.seen[0].url, "https://gateway.example.com/anthropic/v1/messages");
    assert.strictEqual(noKey.seen[0].headers.get("authorization"), null, "a keyless server gets no Authorization header");
    assert.strictEqual(noKey.seen[0].headers.get("anthropic-beta"), null);
    assert.deepStrictEqual([r.text, r.stop], ["hi", "length"]);
    console.log("ok - Anthropic: another address gets the plain endpoint, no beta, and no key when none was given");
  }

  {
    const fails = async (res: () => Response, kind: AiError["kind"], text: RegExp) => {
      await assert.rejects(anthropicProvider(mockFetch(res).fetch).send(opus, "bad-key", { system: "", turns: [{ role: "user", content: "q" }], signal }),
        (e: unknown) => e instanceof AiError && e.kind === kind && text.test(e.message));
    };
    await fails(() => failure(401, "authentication_error", "invalid x-api-key"), "auth", /invalid x-api-key/);
    await fails(() => failure(429, "rate_limit_error", "Number of request tokens has exceeded your rate limit"), "rateLimit", /rate limit/);
    await fails(() => failure(400, "invalid_request_error", "max_tokens: 64000 > 32000"), "badRequest", /max_tokens/);
    await fails(() => failure(404, "not_found_error", "model: claude-nope"), "badRequest", /claude-nope/);
    await fails(() => failure(529, "overloaded_error", "Overloaded"), "server", /Overloaded/);
    await fails(() => stream([start("claude-opus-5-5"), 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n']), "server", /Overloaded/);
    const refusedConnection = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4000"), { code: "ECONNREFUSED" }) }); };
    await assert.rejects(anthropicProvider(refusedConnection).send({ ...gateway, baseUrl: "http://localhost:4000" }, undefined, { system: "", turns: [], signal }),
      (e: unknown) => e instanceof AiError && e.kind === "network" && /localhost:4000/.test(e.message));
    const cancel = new AbortController();
    const hanging = async (_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const pending = anthropicProvider(hanging).send(opus, "k", { system: "", turns: [], signal: cancel.signal });
    setTimeout(() => cancel.abort(), 10);
    await assert.rejects(pending, (e: unknown) => e instanceof AiError && e.kind === "cancelled");
    console.log("ok - Anthropic: typed SDK errors (401, 429, 400, 404, 529, an error event, a refused connection, a cancel) map to AiError");
  }

  {
    const effort = (levels: Record<string, boolean>) => ({ supported: true, ...Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, { supported: v }])) });
    assert.deepStrictEqual(anthropicModel({ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1000000, lifecycle: "active", capabilities: { effort: effort({ low: true, medium: true, high: true, xhigh: true, max: true }) } }),
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", contextTokens: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"] });
    assert.deepStrictEqual(anthropicModel({ id: "claude-haiku-4-5", capabilities: { effort: { supported: false } } })?.efforts, []);
    assert.deepStrictEqual(anthropicModel({ id: "claude-sonnet-4-6" })?.efforts, ["low", "medium", "high", "max"], "no capabilities: the id table");
    assert.strictEqual(anthropicModel({ id: "claude-3-haiku-20240307", lifecycle: "retired" }), undefined);
    const page = { data: [{ id: "claude-opus-5-5", type: "model", display_name: "Claude Opus 5.5", created_at: "2026-09-01T00:00:00Z", lifecycle: "active", capabilities: { effort: effort({ low: true, medium: true, high: true, xhigh: true, max: true }) } },
      { id: "claude-sonnet-5-5", type: "model", display_name: "Claude Sonnet 5.5", created_at: "2026-09-01T00:00:00Z" }], has_more: false, first_id: "claude-opus-5-5", last_id: "claude-sonnet-5-5" };
    const { fetch, seen } = mockFetch(() => new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } }));
    const models = await anthropicProvider(fetch).listModels(opus, "test-key", signal);
    assert.deepStrictEqual(models.map((m) => m.id), ["claude-opus-5-5", "claude-sonnet-5-5"]);
    assert.ok(seen[0].url.startsWith("https://api.anthropic.com/v1/models"));
    console.log("ok - Anthropic: client.models.list() gives the models and the effort levels their capabilities name");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
