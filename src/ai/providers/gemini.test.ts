import * as assert from "assert";
import { configureI18n } from "../../i18n";
import { AiError, type AiProfile, type AiRequest } from "../types";
import { geminiBody, geminiModels, geminiProvider, geminiSchema } from "./gemini";

configureI18n("en");

const sse = (chunks: string[]) => new Response(new ReadableStream<Uint8Array>({
  start(c) {
    for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
    c.close();
  },
}), { headers: { "content-type": "text/event-stream" } });

function mockFetch(answer: () => Response) {
  const seen: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  return {
    seen,
    fetch: async (input: string | URL | Request, init: RequestInit = {}) => {
      seen.push({ url: String(input), init, body: typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {} });
      return answer();
    },
  };
}

const profile: AiProfile = { id: "g", label: "Gemini · gemini-3-flash-preview", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3-flash-preview", effort: "low" };
const signal = new AbortController().signal;
const tool = { name: "filter_log", description: "Filter the Log", parameters: { type: "object" as const, properties: { author: { type: "string" }, range: { type: "object", properties: { since: { type: "string" } }, additionalProperties: false } }, required: ["author"], additionalProperties: false as const } };

(async () => {
  {
    const request: AiRequest = { system: "You are Linyra.", signal, json: true, maxTokens: 800, tools: [tool], turns: [{ role: "user", content: "commits by dana" }] };
    const body = geminiBody(profile, request);
    assert.deepStrictEqual(body.systemInstruction, { parts: [{ text: "You are Linyra." }] });
    assert.deepStrictEqual(body.contents, [{ role: "user", parts: [{ text: "commits by dana" }] }]);
    assert.deepStrictEqual(body.generationConfig, { maxOutputTokens: 800, responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "low" } });
    const decl = (body.tools as { functionDeclarations: { parameters: Record<string, unknown> }[] }[])[0].functionDeclarations[0];
    assert.ok(!("additionalProperties" in decl.parameters), "Gemini's schema subset has no additionalProperties");
    assert.ok(!("additionalProperties" in (decl.parameters.properties as Record<string, Record<string, unknown>>).range));
    assert.deepStrictEqual(geminiSchema({ type: "object", properties: { additionalProperties: { type: "string" } } }), { type: "object", properties: { additionalProperties: { type: "string" } } }, "a property named additionalProperties stays");
    const budget = geminiBody({ ...profile, model: "gemini-2.5-flash", effort: "none" }, { system: "", turns: [], signal });
    assert.deepStrictEqual(budget.generationConfig, { thinkingConfig: { thinkingBudget: 0 } }, "Gemini 2.5 thinks by budget");
    const plain = geminiBody({ ...profile, effort: "default" }, { system: "", turns: [], signal });
    assert.ok(!("generationConfig" in plain) && !("systemInstruction" in plain), "Default and no system: nothing sent");
    console.log("ok - Gemini: request mapping for system, contents, functionDeclarations, JSON, thinkingLevel and thinkingBudget");
  }

  {
    // A thought signature arrives on the first function call; a later empty text part carries another.
    const chunks = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Look"}]}}],"modelVersion":"gemini-3-flash-preview"}\r\n\r\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"ing."}]}}]}\r\n\r\ndata: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"id":"fc-1","name":"filter_log","args":{"author":"rin"}},"thoughtSignature":"sig-A"},{"functionCall":{"id":"fc-2","name":"filter_log","args":{"author":"dana"}}}]}}]}\r\n\r\n',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"","thoughtSignature":"sig-B"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":9,"thoughtsTokenCount":30}}\r\n\r\n',
    ];
    const { fetch, seen } = mockFetch(() => sse(chunks));
    const deltas: string[] = [];
    const r = await geminiProvider(fetch).send(profile, "test-key", { system: "s", turns: [{ role: "user", content: "q" }], tools: [tool], signal, onText: (d) => deltas.push(d) });
    assert.strictEqual(seen[0].url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse");
    assert.strictEqual(new Headers(seen[0].init.headers).get("x-goog-api-key"), "test-key");
    assert.deepStrictEqual(deltas, ["Look", "ing."]);
    assert.strictEqual(r.text, "Looking.");
    assert.strictEqual(r.stop, "tool");
    assert.deepStrictEqual(r.toolCalls.map((c) => [c.id, c.input]), [["fc-1", { author: "rin" }], ["fc-2", { author: "dana" }]]);
    assert.deepStrictEqual(r.usage, { inputTokens: 20, outputTokens: 39 });
    assert.deepStrictEqual((r.raw as { parts: unknown[] }).parts, [
      { text: "Looking." },
      { functionCall: { id: "fc-1", name: "filter_log", args: { author: "rin" } }, thoughtSignature: "sig-A" },
      { functionCall: { id: "fc-2", name: "filter_log", args: { author: "dana" } } },
      { text: "", thoughtSignature: "sig-B" },
    ], "text runs join, signed parts stay as they came");
    // The round trip: the parts go back unchanged, and every answer of the step in one content.
    const next = geminiBody(profile, { system: "s", signal, turns: [
      { role: "user", content: "q" },
      { role: "assistant", content: r.text, toolCalls: r.toolCalls, raw: r.raw },
      { role: "tool", results: [{ id: "fc-1", name: "filter_log", output: "3 commits" }, { id: "fc-2", name: "filter_log", output: "no such author", isError: true }] },
    ] });
    const contents = next.contents as { role: string; parts: Record<string, unknown>[] }[];
    assert.deepStrictEqual(contents[1], { role: "model", parts: (r.raw as { parts: Record<string, unknown>[] }).parts });
    assert.deepStrictEqual(contents[2], { role: "user", parts: [
      { functionResponse: { id: "fc-1", name: "filter_log", response: { result: "3 commits" } } },
      { functionResponse: { id: "fc-2", name: "filter_log", response: { error: "no such author" } } },
    ] });
    console.log("ok - Gemini: SSE text, function calls with thought signatures kept and sent back, usage with thoughts");
  }

  {
    const r = await geminiProvider(mockFetch(() => sse(['data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"filter_log","args":{}}}]},"finishReason":"STOP"}]}\n\n'])).fetch)
      .send({ ...profile, model: "gemini-2.5-flash" }, "k", { system: "", turns: [{ role: "user", content: "q" }], signal });
    assert.ok(r.toolCalls[0].id.startsWith("gemini-call-"));
    // A call without Gemini's id: its answer goes back without one.
    const next = geminiBody(profile, { system: "", signal, turns: [{ role: "assistant", content: "", toolCalls: r.toolCalls }, { role: "tool", results: [{ id: r.toolCalls[0].id, name: "filter_log", output: "ok" }] }] });
    const contents = next.contents as { parts: Record<string, Record<string, unknown>>[] }[];
    assert.ok(!("id" in contents[0].parts[0].functionCall), "a made-up id is never sent");
    assert.strictEqual(contents[0].parts[0].thoughtSignature as unknown, "skip_thought_signature_validator", "history Gemini did not write carries the documented stand-in signature");
    assert.ok(!("id" in contents[1].parts[0].functionResponse));
    const blocked = await geminiProvider(mockFetch(() => sse(['data: {"promptFeedback":{"blockReason":"SAFETY"}}\n\n'])).fetch).send(profile, "k", { system: "", turns: [{ role: "user", content: "q" }], signal });
    assert.strictEqual(blocked.stop, "refusal");
    const cut = await geminiProvider(mockFetch(() => sse(['data: {"candidates":[{"content":{"parts":[{"text":"par"}]},"finishReason":"MAX_TOKENS"}]}\n\n'])).fetch).send(profile, "k", { system: "", turns: [{ role: "user", content: "q" }], signal });
    assert.deepStrictEqual([cut.text, cut.stop], ["par", "length"]);
    const thoughts = await geminiProvider(mockFetch(() => sse(['data: {"candidates":[{"content":{"parts":[{"text":"thinking…","thought":true},{"text":"answer"}]}}]}\n\n'])).fetch).send(profile, "k", { system: "", turns: [{ role: "user", content: "q" }], signal });
    assert.strictEqual(thoughts.text, "answer", "thought summaries are not the answer");
    const array = await geminiProvider(mockFetch(() => new Response('[{"candidates":[{"content":{"parts":[{"text":"a"}]}}]},{"candidates":[{"content":{"parts":[{"text":"b"}]},"finishReason":"STOP"}]}]', { headers: { "content-type": "application/json" } })).fetch)
      .send(profile, "k", { system: "", turns: [{ role: "user", content: "q" }], signal });
    assert.strictEqual(array.text, "ab", "a gateway that ignores alt=sse");
    console.log("ok - Gemini: made-up call ids stay local, blocked prompts are refusals, MAX_TOKENS, thoughts, a JSON-array answer");
  }

  {
    const fails = async (res: () => Response, kind: AiError["kind"], text: RegExp) => {
      await assert.rejects(geminiProvider(mockFetch(res).fetch).send(profile, "bad", { system: "", turns: [{ role: "user", content: "q" }], signal }),
        (e: unknown) => e instanceof AiError && e.kind === kind && text.test(e.message));
    };
    await fails(() => new Response('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}', { status: 400 }), "badRequest", /API key not valid/);
    await fails(() => new Response('{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}', { status: 429 }), "rateLimit", /exhausted/);
    await fails(() => sse(['data: {"error":{"code":500,"message":"Internal error encountered."}}\n\n']), "server", /Internal error/);
    console.log("ok - Gemini: Google's error bodies and an error inside the stream map to AiError");
  }

  {
    const page1 = { models: [
      { name: "models/gemini-3-flash-preview", displayName: "Gemini 3 Flash Preview", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent", "countTokens"], thinking: true },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
    ], nextPageToken: "page-2" };
    const page2 = { models: [{ name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"], thinking: false }] };
    assert.deepStrictEqual(geminiModels(page1).models, [{ id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview", contextTokens: 1048576, efforts: ["minimal", "low", "medium", "high"] }]);
    let n = 0;
    const { fetch, seen } = mockFetch(() => new Response(JSON.stringify(n++ === 0 ? page1 : page2), { headers: { "content-type": "application/json" } }));
    const models = await geminiProvider(fetch).listModels(profile, "test-key", signal);
    assert.deepStrictEqual(models.map((m) => [m.id, m.efforts]), [["gemini-3-flash-preview", ["minimal", "low", "medium", "high"]], ["gemini-2.0-flash", []]]);
    assert.ok(seen[1].url.endsWith("models?pageSize=1000&pageToken=page-2"));
    assert.strictEqual(new Headers(seen[0].init.headers).get("x-goog-api-key"), "test-key");
    console.log("ok - Gemini: models listed across pages, generateContent models only, thinking levels by family");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
