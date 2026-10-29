// A WHATWG fetch over Node's http and https modules. VS Code patches those two modules for every
// extension (http.proxy, http.proxyStrictSSL, http.systemCertificates) on every version this
// extension supports, which its global fetch only does on newer releases. The AI adapters and the
// Anthropic SDK take this function as their `fetch`. Responses stream; an idle socket times out.
import * as http from "http";
import * as https from "https";
import * as zlib from "zlib";
import type { Readable } from "stream";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NodeFetchOptions {
  /** A socket with no traffic this long fails with ETIMEDOUT (connecting, waiting, streaming). */
  idleTimeoutMs?: number;
  maxRedirects?: number;
}

const abortError = (signal: AbortSignal): unknown => signal.reason ?? new DOMException("This operation was aborted", "AbortError");

function bodyOf(body: RequestInit["body"]): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError("Linyra's fetch sends text and byte bodies only.");
}

function decoded(res: http.IncomingMessage): Readable {
  switch (String(res.headers["content-encoding"] ?? "").toLowerCase()) {
    case "gzip": case "x-gzip": return res.pipe(zlib.createGunzip());
    case "deflate": return res.pipe(zlib.createInflate());
    case "br": return res.pipe(zlib.createBrotliDecompress());
    default: return res;
  }
}

/** The response body as a web stream that pauses the socket while nobody reads. */
function webStream(source: Readable, res: http.IncomingMessage, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  let finished = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if ((controller.desiredSize ?? 1) <= 0) source.pause();
      });
      source.on("end", () => {
        if (!finished) { finished = true; controller.close(); }
      });
      // After an abort the socket reports "aborted"; the reader sees the abort itself.
      const fail = (error: unknown) => {
        if (!finished) { finished = true; controller.error(signal?.aborted ? abortError(signal) : error); }
      };
      source.on("error", fail);
      res.on("error", fail);
      // The socket closed before the body ended (a reset, a timeout, an abort).
      res.on("close", () => {
        if (!finished && !res.complete) fail(Object.assign(new Error("The connection closed before the answer was complete."), { code: "ECONNRESET" }));
      });
    },
    pull() {
      source.resume();
    },
    cancel() {
      finished = true;
      res.destroy();
    },
  });
}

/** The headers that carry an API key or a session (OpenAI, Anthropic, Gemini, proxies, cookies). */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-goog-api-key", "api-key", "proxy-authorization", "cookie"];

export function nodeFetch(options: NodeFetchOptions = {}): FetchLike {
  const idle = options.idleTimeoutMs ?? 300_000;
  const maxRedirects = options.maxRedirects ?? 5;
  return async (input, init = {}) => {
    const request = typeof input === "object" && !(input instanceof URL) ? input : undefined;
    let url = new URL(request ? request.url : String(input));
    let method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const headers = new Headers(request?.headers);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    // Ask for plain bytes: a compressed event stream may arrive in bursts.
    headers.set("accept-encoding", "identity");
    let body = bodyOf(init.body);
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw abortError(signal);
    for (let redirects = 0; ; redirects++) {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const outgoing: Record<string, string> = {};
        headers.forEach((value, key) => { outgoing[key] = value; });
        if (body) outgoing["content-length"] = String(body.byteLength);
        const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : undefined;
        if (!transport) {
          reject(new TypeError(`Unsupported protocol ${url.protocol}`));
          return;
        }
        const req = transport.request(url, { method, headers: outgoing });
        const onAbort = () => req.destroy(abortError(signal!) as Error);
        signal?.addEventListener("abort", onAbort, { once: true });
        req.setTimeout(idle, () => req.destroy(Object.assign(new Error(`No answer for ${Math.round(idle / 1000)} seconds.`), { code: "ETIMEDOUT" })));
        req.on("error", (e) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        });
        req.on("response", (r) => {
          r.on("close", () => signal?.removeEventListener("abort", onAbort));
          resolve(r);
        });
        req.end(body);
      });
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && init.redirect !== "manual" && redirects < maxRedirects) {
        res.resume();
        const from = url.origin;
        url = new URL(location, url);
        // A key is only ever sent to the origin it was entered for: a redirect elsewhere goes without it.
        if (url.origin !== from) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
        if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
          if (method !== "HEAD") method = "GET";
          body = undefined;
          headers.delete("content-type");
        }
        continue;
      }
      const out = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) out.append(key, v);
      }
      const source = decoded(res);
      if (source !== res) {
        out.delete("content-encoding");
        out.delete("content-length");
      }
      const empty = method === "HEAD" || status === 204 || status === 205 || status === 304;
      if (empty) res.resume();
      return new Response(empty ? null : webStream(source, res, signal), { status: status >= 200 && status <= 599 ? status : 502, statusText: res.statusMessage ?? "", headers: out });
    }
  };
}

/**
 * One signal for a request: the caller's (a cancel) and Linyra's own deadline. `arm` starts or
 * restarts the timer; the timer aborts with `reason()`; `dispose` drops the listener and timer.
 */
export function linkedSignal(parent: AbortSignal | undefined, reason: () => unknown): { signal: AbortSignal; arm(ms: number): void; disarm(): void; dispose(): void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const forward = () => controller.abort(parent?.reason);
  if (parent?.aborted) forward();
  else parent?.addEventListener("abort", forward, { once: true });
  const disarm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    signal: controller.signal,
    arm(ms) {
      disarm();
      timer = setTimeout(() => controller.abort(reason()), ms);
    },
    disarm,
    dispose() {
      disarm();
      parent?.removeEventListener("abort", forward);
    },
  };
}
