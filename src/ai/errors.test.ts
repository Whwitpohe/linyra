import * as assert from "assert";
import { configureI18n } from "../i18n";
import { AiTimeout, asAiError, httpError, networkError, providerDetail } from "./errors";
import { AiError } from "./types";

configureI18n("en");

{
  const kinds = [[401, "auth"], [403, "auth"], [404, "badRequest"], [400, "badRequest"], [422, "badRequest"], [413, "tooLarge"], [429, "rateLimit"],
    [500, "server"], [503, "server"], [529, "server"], [504, "server"], [407, "network"]] as const;
  for (const [status, kind] of kinds) assert.strictEqual(httpError(status).kind, kind, String(status));
  assert.ok(httpError(401).message.includes("Configure AI"), "the fix is named");
  assert.ok(httpError(429, "You exceeded your current quota.").message.includes("You exceeded your current quota."));
  assert.ok(httpError(403, undefined, true).message.includes("web page"));
  assert.deepStrictEqual(httpError(429, "quota").http, { status: 429, detail: "quota", html: false }, "Test Connection reads the status and the provider's words");
  console.log("ok - HTTP statuses map to AiError kinds with the cause and the fix");
}

{
  assert.strictEqual(providerDetail('{"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: too large"}}'), "max_tokens: too large");
  assert.strictEqual(providerDetail('{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}'), "API key not valid.");
  assert.strictEqual(providerDetail('{"error":"model not found"}'), "model not found");
  assert.strictEqual(providerDetail('[{"error":{"message":"from an array"}}]'), "from an array");
  assert.strictEqual(providerDetail("<!DOCTYPE html><html><body>Sign in</body></html>"), undefined, "a web page is not the provider's words");
  assert.strictEqual(providerDetail("Bad Gateway\n\n"), "Bad Gateway");
  assert.ok(providerDetail("x".repeat(1000))!.length <= 300);
  console.log("ok - the provider's own message is extracted from its error JSON, one bounded line, never a web page");
}

{
  const coded = (code: string, message = code) => Object.assign(new Error(message), { code });
  const wrapped = (inner: Error) => Object.assign(new TypeError("fetch failed"), { cause: inner });
  const url = "https://api.example.com/v1";
  assert.ok(networkError(wrapped(coded("ECONNREFUSED")), "http://localhost:11434/v1").message.includes("localhost:11434"));
  assert.ok(/nothing is listening/.test(networkError(coded("ECONNREFUSED"), url).message));
  assert.ok(/Could not find api\.example\.com/.test(networkError(wrapped(coded("ENOTFOUND")), url).message));
  assert.ok(/systemCertificates/.test(networkError(wrapped(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate")), url).message));
  assert.ok(/SELF_SIGNED_CERT_IN_CHAIN/.test(networkError(coded("SELF_SIGNED_CERT_IN_CHAIN"), url).message));
  assert.ok(/proxy/.test(networkError(new Error("tunneling socket could not be established, statusCode=403"), url).message));
  assert.ok(/closed early/.test(networkError(wrapped(coded("ECONNRESET")), url).message));
  assert.ok(/did not answer in time/.test(networkError(coded("ETIMEDOUT"), url).message));
  for (const e of [coded("ECONNREFUSED"), coded("ENOTFOUND")]) assert.strictEqual(networkError(e, url).kind, "network");
  console.log("ok - network failures name the host and the cause: refused, not found, certificate, proxy, reset, timeout");
}

{
  const own = new AiError("as is", "refusal");
  assert.strictEqual(asAiError(own), own);
  const user = new AbortController();
  user.abort();
  assert.strictEqual(asAiError(new DOMException("aborted", "AbortError"), user.signal).kind, "cancelled");
  const timed = new AbortController();
  timed.abort(new AiTimeout(30));
  const t = asAiError(new DOMException("aborted", "AbortError"), timed.signal, "https://api.anthropic.com");
  assert.strictEqual(t.kind, "network");
  assert.ok(t.message.includes("30 seconds") && t.message.includes("api.anthropic.com"), "a timeout is not a cancel");
  assert.strictEqual(asAiError(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) })).kind, "network");
  assert.strictEqual(asAiError(new Error("something odd")).kind, "server");
  console.log("ok - a cancel, a timeout and other failures become the right AiError");
}
