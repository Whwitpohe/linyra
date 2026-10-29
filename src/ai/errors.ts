// Every way a provider call fails, as one AiError the features show as it is: a sentence that
// names the cause and the fix, never a stack or the provider's JSON. Pure: no vscode import.
import { localize } from "../i18n";
import { AiError } from "./types";

/** The abort reason of a request Linyra timed out itself (not the user's cancel). */
export class AiTimeout extends Error {
  constructor(readonly seconds: number) {
    super(`timeout after ${seconds}s`);
    this.name = "AiTimeout";
  }
}

export function hostOf(url: string | undefined): string {
  if (!url) return localize("the provider");
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const oneLine = (text: string, max = 300): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Whether a response body is a web page (a proxy's block or sign-in page), not an API answer. */
export function isHtml(body: string, contentType = ""): boolean {
  return /text\/html/i.test(contentType) || /^\s*(<!doctype html|<html)/i.test(body);
}

/** The provider's own explanation in an error body ({ error: { message } } and its variants), on one line. */
export function providerDetail(body: string, contentType = ""): string | undefined {
  if (!body.trim() || isHtml(body, contentType)) return undefined;
  try {
    const value = JSON.parse(body) as unknown;
    const pick = (v: unknown): string | undefined => {
      if (typeof v === "string") return v;
      if (Array.isArray(v)) return pick(v[0]);
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        return pick(o.error) ?? (typeof o.message === "string" ? o.message : undefined) ?? (typeof o.detail === "string" ? o.detail : undefined);
      }
      return undefined;
    };
    const found = pick(value);
    return found ? oneLine(found) : undefined;
  } catch {
    return oneLine(body);
  }
}

const withDetail = (message: string, detail: string | undefined): string => (detail ? localize("{0} The provider says: {1}", message, detail) : message);

/** A non-2xx answer. `detail` is the provider's own words (providerDetail). */
export function httpError(status: number, detail?: string, html = false): AiError {
  const page = html ? ` ${localize("It answered with a web page instead of an API response: a proxy or sign-in page may be in the way.")}` : "";
  const make = (message: string, kind: AiError["kind"]) => new AiError(withDetail(message, detail) + page, kind);
  switch (status) {
    case 401: return make(localize("The API key was not accepted (401). Run Linyra: Configure AI… to enter it again."), "auth");
    case 403: return make(localize("Access denied (403): the key cannot use this model or address."), "auth");
    case 404: return make(localize("Not found (404): check the base URL and the model id."), "badRequest");
    case 407: return make(localize("The proxy asks for credentials (407). Check http.proxy and http.proxyAuthorization in the settings."), "network");
    case 408: case 504: return make(localize("The provider timed out ({0}). Try again.", status), "server");
    case 413: return make(localize("The request is too large for this model (413). Send fewer or smaller files."), "tooLarge");
    case 429: return make(localize("Rate limit or quota reached (429). Wait a moment and try again."), "rateLimit");
    case 400: case 422: return make(localize("The provider rejected the request ({0}).", status), "badRequest");
    default:
      return status >= 500 ? make(localize("The provider had a problem ({0}). Try again later.", status), "server")
        : make(localize("The provider answered {0}.", status), status >= 400 ? "badRequest" : "server");
  }
}

const CERTIFICATE = /^(CERT_|UNABLE_TO_(GET|VERIFY|DECRYPT)|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|ERR_TLS_CERT|ERR_SSL_|HOSTNAME_MISMATCH)/;

/** The error and its causes (fetch and the SDKs wrap the socket's error), most specific last. */
function chain(error: unknown): { code?: string; message: string; name?: string }[] {
  const out: { code?: string; message: string; name?: string }[] = [];
  let current: unknown = error;
  for (let i = 0; i < 6 && current; i++) {
    const e = current as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown };
    out.push({ code: typeof e.code === "string" ? e.code : undefined, message: typeof e.message === "string" ? e.message : String(current), name: typeof e.name === "string" ? e.name : undefined });
    current = e.cause;
  }
  return out;
}

export function timeoutError(url: string | undefined, seconds?: number): AiError {
  return new AiError(seconds
    ? localize("{0} did not answer within {1} seconds. Check your network and the proxy settings (http.proxy).", hostOf(url), seconds)
    : localize("{0} did not answer in time. Check your network and the proxy settings (http.proxy).", hostOf(url)), "network");
}

/** A request that never got an HTTP answer: DNS, refused, reset, timed out, certificate, proxy. */
export function networkError(error: unknown, url?: string): AiError {
  const host = hostOf(url);
  const links = chain(error);
  const codes = links.map((l) => l.code).filter((c): c is string => !!c);
  const text = links.map((l) => l.message).join(" ");
  const has = (...wanted: string[]) => codes.some((c) => wanted.includes(c));
  const cert = codes.find((c) => CERTIFICATE.test(c)) ?? (/certificate/i.test(text) ? "certificate" : undefined);
  if (cert) {
    return new AiError(localize("The certificate of {0} is not trusted ({1}). Behind a company proxy, turn on http.systemCertificates; for a local server with its own certificate, add it to the system's trusted certificates or use http://.", host, cert), "network");
  }
  if (/proxy|tunnel/i.test(text) || codes.some((c) => c.startsWith("ERR_PROXY"))) {
    return new AiError(localize("The proxy refused the connection to {0}. Check http.proxy and http.proxyAuthorization in the settings.", host), "network");
  }
  if (has("ECONNREFUSED")) return new AiError(localize("Could not connect to {0}: nothing is listening there. Is the server running?", host), "network");
  if (has("ENOTFOUND", "EAI_AGAIN", "EAI_NODATA")) return new AiError(localize("Could not find {0}. Check the base URL, your network and the proxy settings (http.proxy).", host), "network");
  if (has("ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT") || links.some((l) => l.name === "TimeoutError")) return timeoutError(url);
  if (has("ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET") || /socket hang up|other side closed|terminated/i.test(text)) {
    return new AiError(localize("The connection to {0} was closed early. A proxy or firewall may be blocking it.", host), "network");
  }
  const last = links.at(-1)?.message ?? String(error);
  return new AiError(localize("Could not reach {0}: {1}", host, oneLine(last, 200)), "network");
}

const isAbort = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | undefined)?.name;
  return name === "AbortError" || name === "APIUserAbortError";
};

export const cancelled = (): AiError => new AiError(localize("Cancelled."), "cancelled");

/**
 * Any failure as an AiError. `signal` tells a cancel from a timeout (Linyra aborts with an
 * AiTimeout reason); `url` names the host in network messages.
 */
export function asAiError(error: unknown, signal?: AbortSignal, url?: string): AiError {
  if (error instanceof AiError) return error;
  const reason = signal?.aborted ? (signal.reason as unknown) : undefined;
  if (reason instanceof AiTimeout) return timeoutError(url, reason.seconds);
  if (error instanceof AiTimeout) return timeoutError(url, error.seconds);
  if (signal?.aborted || isAbort(error)) return cancelled();
  const links = chain(error);
  if (links.some((l) => l.code) || (error instanceof TypeError && /fetch failed|network/i.test(links[0]?.message ?? ""))) return networkError(error, url);
  return new AiError(oneLine(links[0]?.message || String(error)), "server");
}
