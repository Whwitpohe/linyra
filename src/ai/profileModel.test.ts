import * as assert from "assert";
import {
  activeAfterRemoval, activeProfile, anthropicAdaptive, anthropicFallbacks, checkBaseUrl, claudeVersion, DEFAULT_EXCLUDE, effortChoices, estimateTokens,
  excludedBy, geminiThinking, globMatcher, isLocalUrl, isPlainRemote, jsonText, knownEfforts, newProfileId, originOf, overLimit, parseProfiles,
  parseSavedKey, profileLabel, protocolEffort, requestChars, sameConnection, upsertProfile, withJsonInstruction, withModel,
} from "./profileModel";
import type { AiProfile } from "./types";

{
  assert.deepStrictEqual(checkBaseUrl(" https://api.openai.com/v1/ "), { url: "https://api.openai.com/v1" });
  assert.deepStrictEqual(checkBaseUrl("http://localhost:11434/v1"), { url: "http://localhost:11434/v1" });
  for (const bad of ["", "api.openai.com", "ftp://host/v1", "https://user:secret@host/v1", "https://host/v1?key=x", "https://host/v1#a"]) {
    assert.ok("error" in checkBaseUrl(bad), `rejected: ${bad}`);
  }
  assert.ok(isLocalUrl("http://localhost:1234/v1") && isLocalUrl("http://127.0.0.1:8080") && isLocalUrl("http://[::1]:11434") && isLocalUrl("http://192.168.1.20:8000/v1"));
  assert.ok(!isLocalUrl("https://api.anthropic.com") && !isLocalUrl("http://172.32.0.1"));
  assert.ok(isPlainRemote("http://gateway.example.com/v1") && !isPlainRemote("http://localhost:1234") && !isPlainRemote("https://gateway.example.com"));
  assert.strictEqual(originOf("https://api.anthropic.com/v1"), "https://api.anthropic.com");
  console.log("ok - base URLs are checked, normalized, and told apart as local, plain-remote or TLS");
}

{
  // Anthropic: the Models API says; the id table covers gateways and Switch AI Model….
  assert.deepStrictEqual(effortChoices("anthropic", { id: "claude-opus-5-5", efforts: ["low", "medium", "high", "xhigh", "max"] }), ["default", "low", "medium", "high", "xhigh", "max"]);
  assert.deepStrictEqual(effortChoices("anthropic", { id: "claude-haiku-4-5", efforts: [] }), ["default"]);
  assert.deepStrictEqual(effortChoices("anthropic", "claude-sonnet-4-6"), ["default", "low", "medium", "high", "max"]);
  assert.deepStrictEqual(effortChoices("anthropic", "my-gateway-model"), ["default", "low", "medium", "high", "xhigh", "max"], "unknown: every Anthropic level");
  // OpenAI: by model family; an unknown server model offers every reasoning_effort value.
  assert.deepStrictEqual(effortChoices("openai", "gpt-5-mini"), ["default", "minimal", "low", "medium", "high"]);
  assert.deepStrictEqual(effortChoices("openai", "gpt-5.2"), ["default", "none", "low", "medium", "high", "xhigh"]);
  assert.deepStrictEqual(effortChoices("openai", "o4-mini"), ["default", "low", "medium", "high"]);
  assert.deepStrictEqual(effortChoices("openai", "gpt-4.1"), ["default"]);
  assert.deepStrictEqual(effortChoices("openai", "llama3.2"), ["default", "none", "minimal", "low", "medium", "high", "xhigh"]);
  // Gemini: 2.5 by budget (Pro cannot turn thinking off), 3 Pro low/high, Flash with minimal.
  assert.deepStrictEqual(effortChoices("gemini", "gemini-2.5-pro"), ["default", "low", "medium", "high"]);
  assert.deepStrictEqual(effortChoices("gemini", "gemini-2.5-flash"), ["default", "none", "low", "medium", "high"]);
  assert.deepStrictEqual(effortChoices("gemini", "gemini-3-pro-preview"), ["default", "low", "high"]);
  assert.deepStrictEqual(effortChoices("gemini", "gemini-3-flash-preview"), ["default", "minimal", "low", "medium", "high"]);
  assert.deepStrictEqual(effortChoices("gemini", "gemini-2.0-flash"), ["default"]);
  assert.strictEqual(knownEfforts("gemini", "some-tuned-model"), undefined);
  // A listed level the protocol has no value for is never offered.
  assert.deepStrictEqual(effortChoices("gemini", { id: "x", efforts: ["max", "high"] }), ["default", "high"]);
  console.log("ok - thinking levels: what the model takes, every level of the protocol when unknown, Default first");
}

{
  assert.strictEqual(protocolEffort("openai", "default"), undefined);
  assert.strictEqual(protocolEffort("openai", "max"), undefined, "a level the protocol lacks is left out");
  assert.strictEqual(protocolEffort("anthropic", "minimal"), undefined);
  assert.strictEqual(protocolEffort("anthropic", "xhigh"), "xhigh");
  assert.deepStrictEqual(geminiThinking("gemini-2.5-flash", "none"), { thinkingBudget: 0 });
  assert.deepStrictEqual(geminiThinking("gemini-2.5-pro", "none"), { thinkingBudget: 128 }, "2.5 Pro cannot disable thinking: its minimum");
  assert.deepStrictEqual(geminiThinking("gemini-2.5-pro", "high"), { thinkingBudget: 32768 });
  assert.deepStrictEqual(geminiThinking("gemini-3-flash-preview", "minimal"), { thinkingLevel: "minimal" });
  assert.deepStrictEqual(geminiThinking("gemini-3.1-pro-preview", "medium"), { thinkingLevel: "medium" });
  assert.strictEqual(geminiThinking("gemini-3-pro-preview", "default"), undefined);
  console.log("ok - levels map to reasoning_effort, output_config.effort and Gemini's budget or level");
}

{
  assert.deepStrictEqual(claudeVersion("claude-haiku-4-5-20251001"), { family: "haiku", major: 4, minor: 5 });
  assert.deepStrictEqual(claudeVersion("claude-opus-5"), { family: "opus", major: 5, minor: 0 });
  for (const m of ["claude-opus-5-5", "claude-fable-5-1", "claude-opus-4-6", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-5-5", "claude-mythos-5-1"]) assert.ok(anthropicAdaptive(m), m);
  for (const m of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1", "claude-3-7-sonnet-20250219", "llama"]) assert.ok(!anthropicAdaptive(m), m);
  for (const m of ["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]) {
    assert.ok(anthropicFallbacks({ baseUrl: "https://api.anthropic.com", model: m }), m);
    assert.ok(!anthropicFallbacks({ baseUrl: "https://gateway.example.com/anthropic", model: m }), `${m} through another address`);
  }
  assert.ok(!anthropicFallbacks({ baseUrl: "https://api.anthropic.com", model: "claude-haiku-5-5" }));
  console.log("ok - adaptive thinking and server-side fallback go only where the model and address take them");
}

{
  const raw = [
    { id: "a", protocol: "anthropic", baseUrl: "https://api.anthropic.com/", model: "claude-opus-5-5", effort: "high", label: "Work" },
    { id: "a", protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "dup" },
    { id: "b", protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "llama3.2", effort: "turbo" },
    { id: "c", protocol: "nope", baseUrl: "https://x", model: "m" },
    { id: "d", protocol: "gemini", baseUrl: "not a url", model: "m" },
    "garbage", null,
  ];
  const profiles = parseProfiles(raw);
  assert.deepStrictEqual(profiles.map((p) => p.id), ["a", "b"]);
  assert.strictEqual(profiles[0].baseUrl, "https://api.anthropic.com");
  assert.strictEqual(profiles[0].label, "Work");
  assert.strictEqual(profiles[1].effort, "default", "an unknown level falls back to Default");
  assert.strictEqual(profiles[1].label, "localhost:11434 · llama3.2");
  assert.strictEqual(profileLabel("anthropic", "https://api.anthropic.com", "claude-opus-5-5"), "Anthropic · claude-opus-5-5");
  assert.strictEqual(profileLabel("gemini", "https://generativelanguage.googleapis.com/v1beta", "gemini-2.5-pro"), "Gemini · gemini-2.5-pro");
  assert.strictEqual(activeProfile(profiles, "b")?.id, "b");
  assert.strictEqual(activeProfile(profiles, "zzz"), undefined, "several profiles and none active: none");
  assert.strictEqual(activeProfile([profiles[0]], undefined)?.id, "a", "the only profile is the active one");
  assert.deepStrictEqual(parseProfiles({ not: "an array" }), []);

  let n = 0;
  const seq = [0.1, 0.1, 0.5];
  const first = newProfileId([], () => seq[n++]);
  n = 0;
  assert.notStrictEqual(newProfileId([first], () => seq[n++]), first, "a taken id is drawn again");
  assert.ok(/^ai-[0-9a-z]{5,}$/.test(first));

  const p: AiProfile = profiles[1];
  assert.strictEqual(sameConnection(profiles, { protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "llama3.2" })?.id, "b");
  const moved = withModel(p, "qwen3", "low");
  assert.strictEqual(moved.label, "localhost:11434 · qwen3", "a generated label follows the model");
  assert.strictEqual(withModel(profiles[0], "claude-sonnet-5-5", "default").label, "Work", "a written label stays");
  assert.deepStrictEqual(upsertProfile(profiles, moved).map((x) => x.model), ["claude-opus-5-5", "qwen3"]);
  assert.deepStrictEqual(upsertProfile(profiles, { ...p, id: "new" }).map((x) => x.id), ["a", "b", "new"]);
  assert.strictEqual(activeAfterRemoval(profiles, "a", ["a"]), "b");
  assert.strictEqual(activeAfterRemoval(profiles, "a", ["b"]), "a");
  assert.strictEqual(activeAfterRemoval(profiles, "a", ["a", "b"]), undefined);
  assert.deepStrictEqual(parseSavedKey(JSON.stringify({ key: "test-key", origin: "https://api.anthropic.com" })), { key: "test-key", origin: "https://api.anthropic.com" });
  assert.strictEqual(parseSavedKey("plain"), undefined);
  console.log("ok - profiles parse leniently, keep their order, and pick the active one; keys are bound to an origin");
}

{
  const request = {
    system: "abcd",
    turns: [
      { role: "user" as const, content: "12345678" },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "1", name: "go", input: { a: 1 } }] },
      { role: "tool" as const, results: [{ id: "1", name: "go", output: "done" }] },
    ],
    tools: [{ name: "go", description: "Go", parameters: { type: "object" as const, properties: {} } }],
  };
  const chars = requestChars(request);
  assert.strictEqual(chars, 4 + 8 + 2 + JSON.stringify({ a: 1 }).length + 4 + 2 + 2 + 2 + JSON.stringify(request.tools[0].parameters).length);
  assert.strictEqual(estimateTokens(10), 3);
  assert.ok(overLimit(50_001, 50_000) && !overLimit(50_000, 50_000) && !overLimit(1e9, 0));
  assert.strictEqual(jsonText('```json\n{"a":1}\n```'), '{"a":1}');
  assert.strictEqual(jsonText(' {"a":1} '), '{"a":1}');
  assert.ok(/JSON/.test(withJsonInstruction("Translate.")) && withJsonInstruction(withJsonInstruction("x")) === withJsonInstruction("x"));
  console.log("ok - prompt size is characters ÷ 4 over system, turns, results and schemas; JSON answers lose their fence");
}

{
  const ex = (path: string) => excludedBy(DEFAULT_EXCLUDE, path);
  for (const path of ["package-lock.json", "web/yarn.lock", "Cargo.lock", "pnpm-lock.yaml", "go.sum", "static/app.min.js", "lib/x.min.css",
    "dist/index.js", "packages/acme-web/dist/a.js", "out/extension.js", "build/x", "node_modules/a/b.js", ".env", "config/.env.local", "certs/server.pem", "id.key"]) {
    assert.ok(ex(path), `excluded: ${path}`);
  }
  for (const path of ["src/index.ts", "README.md", "src/distance.ts", "docs/outline.md", "builder.ts", "src/keys.ts", "environment.ts", "src/lock.ts"]) {
    assert.ok(!ex(path), `kept: ${path}`);
  }
  assert.ok(globMatcher("src/gen/**")!("src/gen/a/b.ts") && !globMatcher("src/gen/**")!("lib/src/gen/a.ts"), "a pattern with / starts at the root");
  assert.ok(globMatcher("**/fixtures/")!("test/fixtures/a.json") && globMatcher("**/fixtures/")!("fixtures/a.json"));
  assert.ok(globMatcher("*.SNAP")!("a/b.snap"), "case-insensitive by default");
  assert.ok(!globMatcher("*.SNAP", false)!("a/b.snap"));
  assert.strictEqual(globMatcher("  "), undefined);
  assert.ok(ex("dist\\win.js"), "Windows separators");
  console.log("ok - exclude globs: names at any depth, folders with a trailing /, anchored paths, ** and lockfile defaults");
}
