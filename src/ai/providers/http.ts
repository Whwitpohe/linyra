// What the fetch-based adapters (OpenAI-compatible, Gemini) share: joining URLs, a deadline per
// request, and turning a non-2xx answer into an AiError. Pure: no vscode import.
import { localize } from "../../i18n";
import { AiTimeout, asAiError, httpError, isHtml, providerDetail } from "../errors";
import { linkedSignal, type FetchLike } from "../net";
import { AiError } from "../types";

export type { FetchLike };

/** Listing models: the whole answer within this. */
export const LIST_TIMEOUT_MS = 30_000;
/** A streamed answer: its headers within this (thinking happens after the stream opens). */
export const HEADERS_TIMEOUT_MS = 120_000;

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Reads at most `limit` characters of a body (an error page can be large). */
async function textOf(res: Response, limit = 16_384): Promise<string> {
  try {
    const text = await res.text();
    return text.length > limit ? text.slice(0, limit) : text;
  } catch {
    return "";
  }
}

/** The AiError for a non-2xx response. */
export async function responseError(res: Response): Promise<Error> {
  const body = await textOf(res);
  const type = res.headers.get("content-type") ?? "";
  return httpError(res.status, providerDetail(body, type), isHtml(body, type));
}

/** A 2xx answer that is not the JSON an API sends: usually a proxy's page. */
export function notJson(body: string, contentType: string): AiError {
  return isHtml(body, contentType)
    ? new AiError(localize("The address answered with a web page instead of an API response: check the base URL; a proxy or sign-in page may be in the way."), "network")
    : new AiError(localize("The answer is not JSON: check that the base URL points at the API."), "server");
}

export interface Call {
  /** Read the response within `ms` of starting; a streamed call disarms after its headers. */
  timeoutMs: number;
  stream: boolean;
}

/**
 * One HTTP call with Linyra's deadline on top of the caller's signal. Returns the 2xx response and
 * the signal the body must be read under (and `done` to release it); throws AiError otherwise.
 */
export async function call(fetch: FetchLike, url: string, init: RequestInit, signal: AbortSignal, options: Call): Promise<{ res: Response; signal: AbortSignal; done(): void }> {
  const seconds = Math.round(options.timeoutMs / 1000);
  const link = linkedSignal(signal, () => new AiTimeout(seconds));
  link.arm(options.timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: link.signal });
    if (options.stream) link.disarm();
    if (!res.ok) throw await responseError(res);
    return { res, signal: link.signal, done: () => link.dispose() };
  } catch (error) {
    link.dispose();
    throw asAiError(error, link.signal, url);
  }
}

/** A whole JSON answer (listing models). */
export async function getJson(fetch: FetchLike, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  const { res, signal: bodySignal, done } = await call(fetch, url, { method: "GET", headers: { accept: "application/json", ...headers } }, signal, { timeoutMs: LIST_TIMEOUT_MS, stream: false });
  try {
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw notJson(text, res.headers.get("content-type") ?? "");
    }
  } catch (error) {
    throw asAiError(error, bodySignal, url);
  } finally {
    done();
  }
}

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Tool arguments as the model sent them: parsed JSON, or the text itself when it is not JSON (the feature's validation reports it). */
export function parseArguments(text: string): unknown {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
