/**
 * Which servers an author's avatar may be asked of, and what their answers mean. Pure: no vscode
 * import, no I/O (src/avatars.ts does the asking).
 *
 * By default (linyra.avatars "remote") an address goes only to a host the repository's own remotes
 * name — a host git already talks to: a GitLab instance's avatar API, GitHub for its noreply
 * addresses. The user's own URL template next, then Gravatar only when the user turned it on.
 */
import { createHash } from "crypto";
import { remoteHost } from "./remoteUrl";
import type { AvatarHostKind, AvatarSettings } from "./settings";

/** Discs are 15 px in the graph and 32 px in the hover card: 64 covers both on a 2x screen. */
export const AVATAR_SIZE = 64;

/** A remote's web server. */
export interface RemoteHost { scheme: "https" | "http"; host: string; port?: string }

export const originOf = (r: RemoteHost): string => `${r.scheme}://${r.host}${r.port ? `:${r.port}` : ""}`;

/** GitHub's and GitLab's other names for themselves: ssh over 443, www. */
const CANONICAL: Readonly<Record<string, string>> = {
  "ssh.github.com": "github.com", "www.github.com": "github.com",
  "altssh.gitlab.com": "gitlab.com", "www.gitlab.com": "gitlab.com",
};

/** Each remote URL's web server, once, in the order given (origin first). Local paths have none. */
export function remoteHosts(urls: readonly string[]): RemoteHost[] {
  const out = new Map<string, RemoteHost>();
  for (const url of urls) {
    const r = remoteHost(url);
    if (!r) continue;
    const canonical = CANONICAL[r.host];
    const host: RemoteHost = canonical ? { scheme: "https", host: canonical } : r;
    if (!out.has(originOf(host))) out.set(originOf(host), host);
  }
  return [...out.values()];
}

/** `git config --get-regexp ^remote\..*\.url$`: the URLs, origin's first. */
export function parseRemoteConfig(stdout: string): string[] {
  const remotes: { name: string; url: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^remote\.(.+)\.url\s+(\S.*)$/.exec(line.trim());
    if (m) remotes.push({ name: m[1], url: m[2].trim() });
  }
  return [...remotes.filter((r) => r.name === "origin"), ...remotes.filter((r) => r.name !== "origin")].map((r) => r.url);
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** The user's linyra.avatarHosts first, then the names GitHub and GitLab go by (gitlab.acme.test, github.acme.test). */
export function hostKind(r: RemoteHost, hosts: Readonly<Record<string, AvatarHostKind>>): AvatarHostKind | undefined {
  for (const key of r.port ? [`${r.host}:${r.port}`, r.host] : [r.host]) if (has(hosts, key)) return hosts[key];
  if (r.host === "github.com") return "github";
  if (r.host === "gitlab.com") return "gitlab";
  const first = r.host.split(".");
  if (first.length < 2) return undefined;
  if (first[0].startsWith("gitlab")) return "gitlab";
  if (first[0].startsWith("github")) return "github";
  return undefined;
}

/** Trimmed and lowercased, as Gravatar hashes it and the webview keys it; "" when it is no address. */
export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@<>"]+@[^\s@<>"]+$/.test(e) ? e : "";
}

/** `<id>+<login>@users.noreply.<host>` or `<login>@users.noreply.<host>` (GitHub's private addresses). */
export function githubNoreply(email: string): { id?: string; login: string; host: string } | undefined {
  const m = /^(?:(\d{1,12})\+)?([a-z0-9](?:[a-z0-9-]{0,38})(?:\[bot\])?)@users\.noreply\.([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i.exec(email.trim());
  return m ? { ...(m[1] ? { id: m[1] } : {}), login: m[2], host: m[3].toLowerCase() } : undefined;
}

const hex = (algorithm: "md5" | "sha256", text: string) => createHash(algorithm).update(text, "utf8").digest("hex");

/** Gravatar by the sha256 of the address; d=404, so a missing picture is no answer rather than a placeholder. */
export function gravatarUrl(email: string, size = AVATAR_SIZE): string {
  return `https://www.gravatar.com/avatar/${hex("sha256", normalizeEmail(email))}?s=${size}&d=404`;
}

/** linyra.avatarUrlTemplate with {md5}, {sha256}, {email} and {size} filled in; undefined when the result is no http(s) URL. */
export function expandTemplate(template: string, email: string, size = AVATAR_SIZE): string | undefined {
  const e = normalizeEmail(email);
  if (!e || !/\{(?:md5|sha256|email)\}/.test(template)) return undefined;
  const filled = template.replace(/\{(md5|sha256|email|size)\}/g, (_, key: string) =>
    key === "md5" ? hex("md5", e) : key === "sha256" ? hex("sha256", e) : key === "email" ? encodeURIComponent(e) : String(size));
  let url: URL;
  try {
    url = new URL(filled);
  } catch {
    return undefined;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.hostname && !url.username && !url.password ? url.href : undefined;
}

/**
 * One place an avatar may come from. `host`: whose circuit breaker it answers to. `allow`: the
 * hosts (and their subdomains) a redirect may lead to; "*" any https host — only for an image URL
 * a GitLab instance chose, which carries no address (its object storage, say).
 */
export type AvatarSource =
  | { kind: "image"; url: string; host: string; allow: readonly string[] }
  /** GitLab's GET /api/v4/avatar: JSON whose avatar_url is fetched only when it is the instance's own. */
  | { kind: "gitlab"; url: string; host: string; allow: readonly string[]; origin: string };

const hostOf = (url: string) => new URL(url).host;
const image = (url: string, allow: readonly string[]): AvatarSource => ({ kind: "image", url, host: hostOf(url), allow });

/**
 * Where an author's avatar may be asked, in order: the repository's remote hosts (GitLab's avatar
 * API; GitHub only for its noreply addresses, the one address it maps to a picture without a
 * token), then the user's template, then Gravatar when the user chose it.
 */
export function avatarSources(email: string, remotes: readonly RemoteHost[], settings: AvatarSettings, size = AVATAR_SIZE): AvatarSource[] {
  const e = normalizeEmail(email);
  if (settings.mode === "off" || !e) return [];
  const sources: AvatarSource[] = [];
  const noreply = githubNoreply(e);
  for (const r of remotes) {
    const kind = hostKind(r, settings.hosts);
    const origin = originOf(r);
    if (kind === "gitlab") {
      const url = `${origin}/api/v4/avatar?email=${encodeURIComponent(e)}&size=${size}`;
      sources.push({ kind: "gitlab", url, host: hostOf(url), allow: [r.host], origin });
    } else if (kind === "github" && noreply?.host === r.host) {
      const login = encodeURIComponent(noreply.login);
      if (r.host === "github.com") {
        sources.push(image(`https://avatars.githubusercontent.com/${noreply.id ? `u/${noreply.id}` : login}?s=${size}`, ["avatars.githubusercontent.com"]));
      } else {
        // GitHub Enterprise Server: /<login>.png answers with a redirect to the instance's avatars.
        sources.push(image(`${origin}/${login}.png?size=${size}`, [r.host]));
      }
    }
  }
  const templated = settings.urlTemplate ? expandTemplate(settings.urlTemplate, e, size) : undefined;
  if (templated) sources.push(image(templated, [new URL(templated).hostname]));
  if (settings.mode === "remote+gravatar") sources.push(image(gravatarUrl(e, size), ["gravatar.com"]));
  const seen = new Set<string>();
  return sources.filter((s) => !seen.has(s.url) && !!seen.add(s.url));
}

const within = (hostname: string, allowed: string) => hostname === allowed || hostname.endsWith(`.${allowed}`);

/**
 * GitLab's answer: its avatar_url when it is a picture on the instance itself. A Gravatar or
 * Libravatar URL (no account matched) is a service the user did not choose to ask — Gravatar, when
 * chosen, is asked directly with d=404 rather than for GitLab's identicon. The instance's own
 * placeholder (/assets/…no_avatar…) is no avatar either.
 */
export function gitlabAvatar(json: unknown, origin: string): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const raw = (json as { avatar_url?: unknown }).avatar_url;
  if (typeof raw !== "string" || raw === "") return undefined;
  let url: URL, base: URL;
  try {
    base = new URL(origin);
    url = new URL(raw, `${origin}/`);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== base.protocol) return undefined;
  if (url.username || url.password || !within(url.hostname, base.hostname)) return undefined;
  if (/\/assets\//.test(url.pathname) || /no_avatar/i.test(url.pathname)) return undefined;
  return url.href;
}

/** A sign-in page, where a server sends a request it wants credentials for (SSO, a login form). */
export function isSignIn(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return /^(?:login|signin|sso|auth|accounts|idp)\./i.test(u.hostname)
    || /(?:^|\/)(?:login|log_in|signin|sign_in|sign-in|session|sessions|sso|saml|saml2|oauth|oauth2|auth|authorize|cas)(?:\/|$)/i.test(u.pathname);
}

/** A redirect may go on: http(s), never from https down to http, and only to a host the source allows. */
export function redirectAllowed(from: string, to: string, allow: readonly string[]): boolean {
  let a: URL, b: URL;
  try {
    a = new URL(from);
    b = new URL(to);
  } catch {
    return false;
  }
  if (b.protocol !== "https:" && !(b.protocol === "http:" && a.protocol === "http:")) return false;
  if (b.username || b.password) return false;
  return allow.some((h) => (h === "*" ? b.protocol === "https:" : within(b.hostname, h)));
}

/** What one HTTP answer means. */
export type Answer =
  | { kind: "body" }
  | { kind: "redirect"; url: string }
  /** The server answered: it has no picture here. */
  | { kind: "none" }
  /** 401, 403, or a sign-in page: not to be asked again this session. */
  | { kind: "refused" }
  /** 429, 5xx: maybe later. */
  | { kind: "transient" };

export function classify(status: number, location: string | undefined, from: string): Answer {
  if (status >= 200 && status < 300) return { kind: "body" };
  if (status >= 300 && status < 400 && status !== 304) {
    if (!location) return { kind: "none" };
    let to: string;
    try {
      to = new URL(location, from).href;
    } catch {
      return { kind: "none" };
    }
    return isSignIn(to) ? { kind: "refused" } : { kind: "redirect", url: to };
  }
  if (status === 401 || status === 403 || status === 407) return { kind: "refused" };
  if (status === 408 || status === 429 || status >= 500) return { kind: "transient" };
  return { kind: "none" };
}

/** The picture's type from its first bytes (never the server's word): PNG, JPEG, GIF or WebP; no SVG. */
export function imageType(bytes: Uint8Array): string | undefined {
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return undefined;
}

/** The webview's copy: CSP allows data: images, and no request leaves it. */
export function dataUri(bytes: Uint8Array): string | undefined {
  const type = imageType(bytes);
  return type ? `data:${type};base64,${Buffer.from(bytes).toString("base64")}` : undefined;
}

/**
 * A host's circuit breaker. closed: asked. open: it failed `failures` times in a row (timeouts,
 * 5xx), asked again after the cooldown. probing: one request after the cooldown decides. broken:
 * it refused (401/403/sign-in) or is no avatar service; not asked again this session.
 */
export type Breaker =
  | { state: "closed"; failures: number }
  | { state: "open"; until: number }
  | { state: "probing" }
  | { state: "broken" };

export const BREAKER = { failures: 3, cooldownMs: 5 * 60_000 } as const;
export const CLOSED: Breaker = { state: "closed", failures: 0 };

export function admit(b: Breaker, now: number): { ok: boolean; next: Breaker } {
  if (b.state === "closed") return { ok: true, next: b };
  if (b.state === "open" && now >= b.until) return { ok: true, next: { state: "probing" } };
  return { ok: false, next: b };
}

export function record(b: Breaker, result: "ok" | "transient" | "refused", now: number): Breaker {
  if (b.state === "broken" || result === "refused") return { state: "broken" };
  if (result === "ok") return CLOSED;
  if (b.state === "probing") return { state: "open", until: now + BREAKER.cooldownMs };
  if (b.state === "open") return b; // a request sent before it opened
  return b.failures + 1 >= BREAKER.failures ? { state: "open", until: now + BREAKER.cooldownMs } : { state: "closed", failures: b.failures + 1 };
}

/** Every host's breaker, for one session. */
export class Breakers {
  private readonly byHost = new Map<string, Breaker>();

  get(host: string): Breaker {
    return this.byHost.get(host) ?? CLOSED;
  }

  admit(host: string, now: number): boolean {
    const { ok, next } = admit(this.get(host), now);
    this.byHost.set(host, next);
    return ok;
  }

  /** The state it moved to, so the caller can say when a host stopped being asked. */
  record(host: string, result: "ok" | "transient" | "refused", now: number): Breaker {
    const next = record(this.get(host), result, now);
    this.byHost.set(host, next);
    return next;
  }
}
