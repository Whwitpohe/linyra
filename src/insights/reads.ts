// One Insights tab's reads: what was read per repository for one key (scope path and range),
// read one process per repository, safe against overlapping requests. Pure: no vscode.
import { isAbortError, runPool } from "../pool";

/**
 * What a tab read, per repository, for one key. It lives as long as the Insights tab is open, like
 * the Log's rows: switching tabs shows it again without git, and a repository whose refs moved is
 * dropped from it, so only that one is read again.
 */
export interface Answer<T> {
  key: string;
  /** The read's clock: every repository's range starts at the same moment. */
  now: number;
  byRepo: Map<string, { value?: T; error?: string }>;
  /** Bumped whenever byRepo changes: what is built from it (a treemap's tree) is built again. */
  version: number;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A tab's answer and the one read filling it. A newer request wins: fill() says whether the
 * caller's request is still the latest, so an older one never posts over it. A repository that
 * goes stale (refs moved) while it is being read is not stored from that read: it stays missing,
 * and the next fill reads it. Results are stored as each repository lands, so stopping a read
 * loses only what was still in flight.
 */
export class TabReads<T> {
  answer: Answer<T> | undefined;
  private flight: { answer: Answer<T>; ctl: AbortController; done: Promise<void> } | undefined;
  private request = 0;
  /** Bumped per repository when it goes stale; a read started before keeps its own number. */
  private readonly epochs = new Map<string, number>();
  private epoch = 0;

  constructor(private readonly clock: () => number = () => Math.floor(Date.now() / 1000)) {}

  /** The answer for `key`: the one there is, or a fresh one (and the old one's read stops). */
  for(key: string): Answer<T> {
    if (this.answer?.key === key) return this.answer;
    this.flight?.ctl.abort();
    this.answer = { key, now: this.clock(), byRepo: new Map(), version: 0 };
    return this.answer;
  }

  /** Refresh: the next request reads everything again, on a new clock. */
  forget(): void {
    this.flight?.ctl.abort();
    this.answer = undefined;
  }

  /** A repository's refs moved (undefined: every repository's, after Fetch All). */
  stale(id: string | undefined): void {
    if (id === undefined) {
      this.epoch++;
      this.answer?.byRepo.clear();
    } else {
      this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
      this.answer?.byRepo.delete(id);
    }
    if (this.answer) this.answer.version++;
  }

  /** Stops the read (the tab is not shown); what already arrived stays. */
  stop(): void {
    this.flight?.ctl.abort();
  }

  get reading(): boolean {
    return !!this.flight && !this.flight.ctl.signal.aborted;
  }

  /** Starts a request: its number, for isLatest() after its awaits. */
  begin(): number {
    return ++this.request;
  }

  /** Whether no later request has come since this one began. */
  isLatest(request: number): boolean {
    return request === this.request;
  }

  /**
   * Reads, one call of `read` per repository, the repositories the answer lacks (waiting first for
   * a read of the same answer already running, so nothing is read twice). True when `request` is
   * still the latest: the caller may post what the answer holds.
   */
  async fill<R extends { id: string }>(request: number, answer: Answer<T>, repos: readonly R[], limit: number,
    read: (repo: R, signal: AbortSignal) => Promise<T>): Promise<boolean> {
    while (this.flight && this.flight.answer === answer && !this.flight.ctl.signal.aborted) await this.flight.done;
    if (!this.isLatest(request) || this.answer !== answer) return false;
    const missing = repos.filter((r) => !answer.byRepo.has(r.id));
    if (missing.length === 0) return true;
    this.flight?.ctl.abort();
    const ctl = new AbortController();
    const mark = (id: string) => `${this.epoch}:${this.epochs.get(id) ?? 0}`;
    const started = new Map(missing.map((r) => [r.id, mark(r.id)]));
    const keep = (id: string) => this.answer === answer && !ctl.signal.aborted && started.get(id) === mark(id);
    const done = runPool(missing, limit, async (repo, signal) => {
      try {
        const value = await read(repo, signal);
        if (keep(repo.id)) { answer.byRepo.set(repo.id, { value }); answer.version++; }
      } catch (e) {
        if (!isAbortError(e) && keep(repo.id)) { answer.byRepo.set(repo.id, { error: messageOf(e) }); answer.version++; }
      }
    }, ctl.signal).then(() => undefined);
    const flight = { answer, ctl, done };
    this.flight = flight;
    await done;
    if (this.flight === flight) this.flight = undefined;
    // Stopped (the tab was hidden, or the key changed): what arrived stays, but it is not complete.
    if (ctl.signal.aborted || !this.isLatest(request) || this.answer !== answer) return false;
    // A repository that went stale meanwhile is missing again: read it now, for this same request.
    if (repos.some((r) => !answer.byRepo.has(r.id))) return this.fill(request, answer, repos, limit, read);
    return true;
  }
}
