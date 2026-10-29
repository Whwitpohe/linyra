// The Changes column's reads, host side: the webview names the commits on screen (as it does
// authors for avatars), and each repository among them costs one git process. A commit's stats
// never change, so those already read in this session are answered from memory, never read
// again; a newer request kills the older one still running. No vscode import.
import { parseStats, statsArgs, statsRequests, type CommitStats } from "./changeStats";
import type { RunGit } from "./logQuery";
import { runPool } from "./pool";
import type { MessageRoutes } from "./messageRoutes";

/** Read stats kept for the session: enough for every row a long scroll shows, bounded. */
const KEEP = 20_000;

export type StatsBatch = Record<string, [files: number, added: number, deleted: number]>;

export const statsKey = (repoId: string, sha: string): string => `${repoId}\0${sha}`;

export interface StatsHost {
  run: RunGit;
  /** A listed repository's root (undefined: not one the Log lists). */
  rootOf(repoId: string): string | undefined;
  maxConcurrency(): number;
  post(byKey: StatsBatch): void;
}

export class ChangeStatsReader {
  private readonly known = new Map<string, CommitStats>();
  private ctl: AbortController | undefined;

  constructor(private readonly host: StatsHost) {}

  /** The commits on screen (untrusted: {repoId, sha}[] from the webview). */
  register(routes: MessageRoutes): void {
    // Not awaited: a newer request aborts this one, and the webview waits for nothing.
    routes.on("wantStats", (m) => { void this.want(Array.isArray(m.commits) ? m.commits : []); });
  }

  async want(commits: readonly unknown[]): Promise<void> {
    const ready: StatsBatch = {};
    const missing: [string, string, string[]][] = [];
    for (const [repoId, shas] of statsRequests(commits, (id) => this.host.rootOf(id) !== undefined)) {
      const need = shas.filter((sha) => {
        const hit = this.known.get(statsKey(repoId, sha));
        if (hit) ready[statsKey(repoId, sha)] = [hit.files, hit.added, hit.deleted];
        return !hit;
      });
      if (need.length > 0) missing.push([repoId, this.host.rootOf(repoId)!, need]);
    }
    if (Object.keys(ready).length > 0) this.host.post(ready);
    if (missing.length === 0) return;
    this.ctl?.abort();
    const ctl = (this.ctl = new AbortController());
    await runPool(missing, this.host.maxConcurrency(), async ([repoId, root, shas], signal) => {
      const read = parseStats(await this.host.run(root, statsArgs(), signal, { input: `${shas.join("\n")}\n` }));
      if (signal.aborted) return;
      const batch: StatsBatch = {};
      for (const sha of shas) {
        // An id git did not print (gone after a rewrite) reads as nothing changed, and is not kept.
        const stats = read.get(sha);
        if (stats) this.remember(statsKey(repoId, sha), stats);
        const s = stats ?? { files: 0, added: 0, deleted: 0 };
        batch[statsKey(repoId, sha)] = [s.files, s.added, s.deleted];
      }
      this.host.post(batch);
    }, ctl.signal).catch(() => undefined);
  }

  dispose(): void {
    this.ctl?.abort();
  }

  private remember(key: string, stats: CommitStats): void {
    if (this.known.size >= KEEP) this.known.delete(this.known.keys().next().value!);
    this.known.set(key, stats);
  }
}
