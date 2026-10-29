import * as assert from "assert";
import * as http from "http";
import * as zlib from "zlib";
import type { AddressInfo } from "net";
import { linkedSignal, nodeFetch } from "./net";
import { readSse } from "./sse";

// A local server stands in for a provider: no real endpoint is ever called.
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    switch (req.url) {
      case "/echo":
        res.writeHead(200, { "content-type": "application/json", "x-multi": ["a", "b"] });
        res.end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization, encoding: req.headers["accept-encoding"],
          keys: ["x-api-key", "x-goog-api-key"].filter((h) => req.headers[h] !== undefined) }));
        return;
      case "/sse":
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => {
          res.write("data: t");
          setTimeout(() => res.end("wo\n\n"), 10);
        }, 10);
        return;
      case "/endless":
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: start\n\n");
        return; // never ends
      case "/redirect":
        res.writeHead(307, { location: "/echo" });
        res.end();
        return;
      case "/elsewhere":
        // The same server under another origin (localhost, not 127.0.0.1).
        res.writeHead(307, { location: `http://localhost:${(server.address() as AddressInfo).port}/echo` });
        res.end();
        return;
      case "/gzip":
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(zlib.gzipSync("compressed text"));
        return;
      case "/status":
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end('{"error":{"message":"slow down"}}');
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
});

(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetch = nodeFetch({ idleTimeoutMs: 300 });
  try {
    {
      const res = await fetch(`${base}/echo`, { method: "POST", headers: { authorization: "Bearer test-key", "content-type": "application/json" }, body: '{"q":1}' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("x-multi"), "a, b");
      const echo = await res.json() as { method: string; body: string; auth: string; encoding: string };
      assert.deepStrictEqual(echo, { method: "POST", body: '{"q":1}', auth: "Bearer test-key", encoding: "identity", keys: [] });
      const redirected = await (await fetch(`${base}/redirect`, { method: "POST", body: "kept" })).json() as { method: string; body: string };
      assert.deepStrictEqual([redirected.method, redirected.body], ["POST", "kept"], "307 keeps the method and body");
      const keyed = { authorization: "Bearer test-key", "x-api-key": "test-key", "x-goog-api-key": "test-key" };
      assert.strictEqual((await (await fetch(`${base}/redirect`, { headers: keyed })).json() as { auth: string }).auth, "Bearer test-key", "the same origin keeps the key");
      const away = await (await fetch(`${base}/elsewhere`, { headers: keyed })).json() as { auth?: string; keys: string[] };
      assert.deepStrictEqual([away.auth, away.keys], [undefined, []], "a redirect to another origin never carries the key");
      assert.strictEqual(await (await fetch(`${base}/gzip`)).text(), "compressed text");
      const limited = await fetch(`${base}/status`);
      assert.strictEqual(limited.status, 429);
      assert.strictEqual(limited.headers.get("retry-after"), "1");
      console.log("ok - node fetch: method, headers, body, 307 redirect, gzip, error statuses");
    }

    {
      const res = await fetch(`${base}/sse`);
      const seen: string[] = [];
      for await (const e of readSse(res.body!)) seen.push(e.data);
      assert.deepStrictEqual(seen, ["one", "two"]);
      console.log("ok - node fetch streams an event stream as it arrives");
    }

    {
      const controller = new AbortController();
      const res = await fetch(`${base}/endless`, { signal: controller.signal });
      const reader = res.body!.getReader();
      await reader.read();
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(async () => {
        for (;;) if ((await reader.read()).done) break;
      }, (e: Error) => e.name === "AbortError");
      const aborted = new AbortController();
      aborted.abort();
      await assert.rejects(fetch(`${base}/echo`, { signal: aborted.signal }), (e: Error) => e.name === "AbortError");
      console.log("ok - node fetch: an abort ends the stream with an AbortError, an aborted signal never sends");
    }

    {
      const res = await fetch(`${base}/endless`);
      const reader = res.body!.getReader();
      await reader.read();
      await assert.rejects(async () => {
        for (;;) if ((await reader.read()).done) break;
      }, (e: { code?: string }) => e.code === "ETIMEDOUT" || e.code === "ECONNRESET");
      await assert.rejects(fetch("http://127.0.0.1:1/never"), (e: { code?: string }) => e.code === "ECONNREFUSED");
      console.log("ok - node fetch: an idle stream times out; a refused connection keeps its error code");
    }

    {
      const parent = new AbortController();
      const link = linkedSignal(parent.signal, () => new Error("deadline"));
      link.arm(10);
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(link.signal.aborted && (link.signal.reason as Error).message === "deadline");
      const second = linkedSignal(parent.signal, () => new Error("deadline"));
      second.arm(1000);
      parent.abort(new Error("user"));
      assert.strictEqual((second.signal.reason as Error).message, "user");
      second.dispose();
      const disarmed = linkedSignal(undefined, () => new Error("deadline"));
      disarmed.arm(10);
      disarmed.disarm();
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(!disarmed.signal.aborted);
      console.log("ok - linked signals: a deadline aborts with its reason, the caller's cancel passes through, disarm stops the timer");
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
