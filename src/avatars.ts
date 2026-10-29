/**
 * Author avatars for the rows on screen (linyra.avatars). The webview says whose rows it shows;
 * this asks the servers avatarModel allows — four requests at a time, three seconds each — turns
 * each picture into a data: URI, and sends them to the webview in batches. Everything stays in
 * memory for the session: no index, no cache on disk (constraint 1).
 *
 * No vscode import: logView.ts hands it the settings, the remotes and the webview; the tests hand
 * it a fetch. Requests go through Node's https, which VS Code patches for proxies and the system's
 * certificates.
 */
import * as http from "http";
import * as https from "https";
import { localize } from "./i18n";
import {
  avatarSources, Breakers, classify, dataUri, gitlabAvatar, normalizeEmail, redirectAllowed, remoteHosts, BREAKER,
  type AvatarSource, type RemoteHost,
} from "./avatarModel";
import type { AvatarSettings } from "./settings";

export interface AvatarResponse {
  status: number;
  location?: string;
  contentType?: string;
  /** null: larger than asked for, not read. */
  body: Uint8Array | null;
}

/** One GET, redirects not followed (the caller decides where they may lead). */
export type AvatarFetch = (url: string, options: { signal: AbortSignal; maxBytes: number }) => Promise<AvatarResponse>;

/** A webview's report: an author of a row on screen, and the row's repository. */
export interface VisibleAuthor { email: string; repoId: string }

export interface AvatarDeps {
  settings(): AvatarSettings;
  /** The repository's remote URLs, origin first (VS Code's Git, else one git process). */
  remotes(repoId: string, signal: AbortSignal): Promise<readonly string[]>;
  /** A batch for the webview. reset: forget the avatars sent before (the settings changed). */
  post(byEmail: Record<string, string>, reset: boolean): void;
  log?(message: string): void;
  fetch?: AvatarFetch;
  now?(): number;
  timeoutMs?: number;
  batchMs?: number;
}

const CONCURRENCY = 4;
const TIMEOUT_MS = 3000;
/** A batch waits this long for more answers: the rows are redrawn a few times a second at most. */
const BATCH_MS = 250;
const MAX_REDIRECTS = 3;
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
/** Avatars kept for the session; the oldest go first (a few KB each). */
const MAX_KEPT = 1000;
/** The most authors one report may name: a screen of rows holds a few dozen. */
export const MAX_VISIBLE_AUTHORS = 300;

/** The webview's report, validated: only addresses, and only repositories the Log lists. */
export function visibleAuthors(input: unknown, isRepo: (id: string) => boolean): VisibleAuthor[] {
  if (!Array.isArray(input)) return [];
  const out: VisibleAuthor[] = [];
  for (const a of input.slice(0, MAX_VISIBLE_AUTHORS)) {
    if (!a || typeof a !== "object") continue;
    const { email, repoId } = a as { email?: unknown; repoId?: unknown };
    if (typeof email === "string" && typeof repoId === "string" && normalizeEmail(email) && isRepo(repoId)) out.push({ email, repoId });
  }
  return out;
}

type Result = { kind: "found"; uri: string } | { kind: "none" } | { kind: "later" };
type Got = { kind: "body"; body: Uint8Array; contentType: string } | { kind: "none"; status?: number } | { kind: "later" };

export class Avatars {
  /** email → data: URI, for the session. */
  private readonly found = new Map<string, string>();
  /** email → the source URLs that had nothing for it (or whose host refused): not asked again. */
  private readonly tried = new Map<string, Set<string>>();
  private readonly remoteCache = new Map<string, Promise<RemoteHost[]>>();
  private breakers = new Breakers();
  /** The authors on screen, by email: their repositories. */
  private wanted = new Map<string, ReadonlySet<string>>();
  private queue: string[] = [];
  private running = new Set<string>();
  /** What the current webview has (a re-created one has nothing). */
  private readonly sent = new Set<string>();
  private batch: Record<string, string> = {};
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  /** Requests of the current settings; aborted when they change. */
  private requests = new AbortController();
  /** Remote reads; aborted only on dispose (the remotes do not change with the settings). */
  private readonly lifetime = new AbortController();
  private generation = 0;
  private readonly fetch: AvatarFetch;

  constructor(private readonly deps: AvatarDeps) {
    this.fetch = deps.fetch ?? nodeFetch;
  }

  /** The webview's rows on screen changed: ask for the avatars they lack, drop what scrolled away. */
  want(authors: readonly VisibleAuthor[]): void {
    const wanted = new Map<string, Set<string>>();
    for (const a of authors) {
      const email = normalizeEmail(a.email);
      if (!email) continue;
      let repos = wanted.get(email);
      if (!repos) wanted.set(email, (repos = new Set()));
      repos.add(a.repoId);
    }
    this.wanted = wanted;
    if (this.deps.settings().mode === "off") {
      this.queue = [];
      return;
    }
    // Found before: this webview gets them at once, with no request.
    for (const email of wanted.keys()) {
      const uri = this.found.get(email);
      if (uri && !this.sent.has(email)) this.add(email, uri);
    }
    // In screen order; what scrolled away before its turn is not asked.
    this.queue = [...wanted.keys()].filter((e) => !this.found.has(e) && !this.running.has(e));
    this.pump();
    if (this.running.size === 0) this.flush();
  }

  /** A new webview (the old one was disposed): it has no avatar yet. */
  webviewReset(): void {
    this.sent.clear();
    this.batch = {};
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
  }

  /** linyra.avatars* changed: forget every answer and ask again for the rows on screen. */
  settingsChanged(): void {
    this.generation++;
    this.requests.abort();
    this.requests = new AbortController();
    this.found.clear();
    this.tried.clear();
    this.breakers = new Breakers();
    this.running = new Set();
    this.webviewReset();
    this.deps.post({}, true);
    this.want([...this.wanted].flatMap(([email, repos]) => [...repos].map((repoId) => ({ email, repoId }))));
  }

  dispose(): void {
    this.generation++;
    this.requests.abort();
    this.lifetime.abort();
    clearTimeout(this.batchTimer);
    this.queue = [];
  }

  private pump(): void {
    while (this.running.size < CONCURRENCY && this.queue.length > 0) {
      const email = this.queue.shift()!;
      const repos = this.wanted.get(email);
      if (!repos || this.found.has(email) || this.running.has(email)) continue;
      const generation = this.generation;
      const running = this.running;
      running.add(email);
      void this.resolve(email, repos, generation).catch(() => undefined).finally(() => {
        running.delete(email);
        if (generation !== this.generation) return;
        this.pump();
        if (this.running.size === 0) this.flush();
      });
    }
  }

  private async resolve(email: string, repos: ReadonlySet<string>, generation: number): Promise<void> {
    const hosts = (await Promise.all([...repos].map((id) => this.remoteHostsOf(id)))).flat();
    if (generation !== this.generation) return;
    let tried = this.tried.get(email);
    for (const source of avatarSources(email, hosts, this.deps.settings())) {
      if (tried?.has(source.url)) continue;
      const result = await this.ask(source);
      if (generation !== this.generation) return;
      if (result.kind === "found") {
        this.keep(email, result.uri);
        return;
      }
      // "later": a timeout, or its host cooling down; asked again when the author is on screen again.
      if (result.kind === "none") {
        if (!tried) this.tried.set(email, (tried = new Set()));
        tried.add(source.url);
      }
    }
  }

  private remoteHostsOf(repoId: string): Promise<RemoteHost[]> {
    let hosts = this.remoteCache.get(repoId);
    if (!hosts) {
      hosts = this.deps.remotes(repoId, this.lifetime.signal).then((urls) => remoteHosts(urls), () => []);
      this.remoteCache.set(repoId, hosts);
    }
    return hosts;
  }

  private async ask(source: AvatarSource): Promise<Result> {
    if (source.kind === "image") return this.image(source.url, source.host, source.allow);
    const notGitLab = () => {
      this.refuse(source.host, localize("Avatars: {0} did not answer as a GitLab server. If it is another kind of server, name it in linyra.avatarHosts.", source.host));
      return { kind: "none" } as const;
    };
    const api = await this.get(source.url, source.host, source.allow, MAX_JSON_BYTES);
    // GitLab answers every address (a placeholder when no account matches): a 404 is no GitLab API.
    if (api.kind === "none" && api.status === 404) return notGitLab();
    if (api.kind !== "body") return api.kind === "none" ? { kind: "none" } : api;
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(api.body).toString("utf8"));
    } catch {
      return notGitLab(); // a page instead of GitLab's JSON: a portal in front of it, or no GitLab at all
    }
    const picture = gitlabAvatar(json, source.origin);
    // The picture's URL names no author: it may come from the instance's own storage.
    return picture ? this.image(picture, source.host, ["*"]) : { kind: "none" };
  }

  private async image(url: string, host: string, allow: readonly string[]): Promise<Result> {
    const got = await this.get(url, host, allow, MAX_IMAGE_BYTES);
    if (got.kind !== "body") return got;
    const uri = dataUri(got.body);
    if (uri) return { kind: "found", uri };
    // A page where a picture should be: a sign-in or portal page served as 200.
    if (/text\/html/i.test(got.contentType)) this.refuse(host, localize("Avatars: {0} sent a sign-in page. Linyra stops asking it until the window reloads.", host));
    return { kind: "none" };
  }

  /** One GET and its redirects, through the host's breaker. */
  private async get(url: string, host: string, allow: readonly string[], maxBytes: number): Promise<Got> {
    const now = () => this.deps.now?.() ?? Date.now();
    let at = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!this.breakers.admit(host, now())) return this.breakers.get(host).state === "broken" ? { kind: "none" } : { kind: "later" };
      let res: AvatarResponse;
      const signal = this.requests.signal;
      try {
        res = await this.withTimeout(at, maxBytes, signal);
      } catch {
        if (signal.aborted) return { kind: "later" }; // the settings changed, or the view closed
        this.transient(host, now());
        return { kind: "later" };
      }
      const answer = classify(res.status, res.location, at);
      if (answer.kind === "refused") {
        this.refuse(host, res.status >= 300 && res.status < 400
          ? localize("Avatars: {0} sent a sign-in page. Linyra stops asking it until the window reloads.", host)
          : localize("Avatars: {0} answered HTTP {1}. Linyra stops asking it until the window reloads.", host, res.status));
        return { kind: "none" };
      }
      if (answer.kind === "transient") {
        this.transient(host, now());
        return { kind: "later" };
      }
      this.breakers.record(host, "ok", now());
      if (answer.kind === "none") return { kind: "none", status: res.status };
      if (answer.kind === "redirect") {
        if (!redirectAllowed(at, answer.url, allow)) return { kind: "none" };
        at = answer.url;
        continue;
      }
      return res.body ? { kind: "body", body: res.body, contentType: res.contentType ?? "" } : { kind: "none" };
    }
    return { kind: "none" };
  }

  private async withTimeout(url: string, maxBytes: number, parent: AbortSignal): Promise<AvatarResponse> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.deps.timeoutMs ?? TIMEOUT_MS);
    try {
      return await this.fetch(url, { signal: controller.signal, maxBytes });
    } finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    }
  }

  private refuse(host: string, message: string): void {
    const before = this.breakers.get(host).state;
    this.breakers.record(host, "refused", this.deps.now?.() ?? Date.now());
    if (before !== "broken") this.deps.log?.(message);
  }

  private transient(host: string, now: number): void {
    const before = this.breakers.get(host).state;
    const after = this.breakers.record(host, "transient", now).state;
    if (after === "open" && before !== "open") {
      this.deps.log?.(localize("Avatars: {0} did not answer in time. Linyra asks it again in {1} minutes.", host, BREAKER.cooldownMs / 60_000));
    }
  }

  private keep(email: string, uri: string): void {
    this.found.set(email, uri);
    if (this.found.size > MAX_KEPT) {
      const oldest = this.found.keys().next().value as string;
      this.found.delete(oldest);
      this.sent.delete(oldest);
    }
    // Scrolled away meanwhile: it is sent when it is on screen again.
    if (this.wanted.has(email)) this.add(email, uri);
  }

  private add(email: string, uri: string): void {
    this.batch[email] = uri;
    this.sent.add(email);
    this.batchTimer ??= setTimeout(() => this.flush(), this.deps.batchMs ?? BATCH_MS);
  }

  private flush(): void {
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    if (Object.keys(this.batch).length === 0) return;
    const batch = this.batch;
    this.batch = {};
    this.deps.post(batch, false);
  }
}

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp;q=0.9,application/json;q=0.8";

/** Node's https (patched by VS Code: http.proxy, system certificates). No cookies, no credentials. */
export const nodeFetch: AvatarFetch = (url, { signal, maxBytes }) => new Promise((resolve, reject) => {
  const target = new URL(url);
  const get = target.protocol === "http:" ? http.get : https.get;
  const req = get(target, { signal, headers: { accept: ACCEPT, "user-agent": "Linyra (VS Code)" } }, (res) => {
    const head = { status: res.statusCode ?? 0, location: res.headers.location, contentType: res.headers["content-type"] };
    if (head.status < 200 || head.status >= 300 || Number(res.headers["content-length"]) > maxBytes) {
      res.resume();
      resolve({ ...head, body: head.status >= 200 && head.status < 300 ? null : new Uint8Array(0) });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        resolve({ ...head, body: null });
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => resolve({ ...head, body: new Uint8Array(Buffer.concat(chunks)) }));
    res.on("error", reject);
  });
  req.on("error", reject);
});
