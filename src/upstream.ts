import { localize } from "./i18n";
/**
 * How far each repository's current branch is from its upstream, for the Repositories
 * pane's ↓/↑ badge. Local refs only (as of the last fetch): Linyra never fetches.
 * Pure: no vscode import.
 */
export interface AheadBehind {
  /** Commits on HEAD that the upstream does not have (not pushed). */
  ahead: number;
  /** Commits on the upstream that HEAD does not have (to pull). */
  behind: number;
}

/** Fails (no output to parse) on a detached HEAD or a branch without an upstream. */
export function aheadBehindArgs(): string[] {
  return ["rev-list", "--left-right", "--count", "HEAD...@{upstream}", "--"];
}

export function parseAheadBehind(out: string): AheadBehind | null {
  const m = /^(\d+)\t(\d+)\s*$/.exec(out);
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null;
}

const commits = (n: number) => localize("{0} {1}", n, localize(n === 1 ? "commit" : "commits"));

/** The badge beside a repository's name, or null when it is up to date. */
export function syncLabel(s: AheadBehind): { text: string; title: string; behind: boolean } | null {
  const parts: string[] = [];
  const titles: string[] = [];
  if (s.behind > 0) {
    parts.push(`↓${s.behind}`);
    titles.push(localize("{0} to pull from its upstream", commits(s.behind)));
  }
  if (s.ahead > 0) {
    parts.push(`↑${s.ahead}`);
    titles.push(localize("{0} not pushed", commits(s.ahead)));
  }
  return parts.length === 0 ? null : { text: parts.join(" "), title: titles.join(", "), behind: s.behind > 0 };
}

/**
 * Fetch All: each repository's default remote, as VS Code's own Fetch; --prune per
 * git.pruneOnFetch. Submodules are listed (and fetched) as repositories of their own: a parent
 * fetching them at the same moment would race it for their refs.
 */
export function fetchArgs(prune: boolean): string[] {
  return ["fetch", "--quiet", "--recurse-submodules=no", ...(prune ? ["--prune"] : [])];
}

/** Fetch All runs unattended: no terminal prompt, and no GUI credential dialog either. */
export const FETCH_ENV: Record<string, string> = { GCM_INTERACTIVE: "never", SSH_ASKPASS_REQUIRE: "never" };

/** The repositories with commits to pull, in repository order. */
export function behindRepos(repoIds: readonly string[], sync: Readonly<Record<string, AheadBehind>>): string[] {
  return repoIds.filter((id) => (sync[id]?.behind ?? 0) > 0);
}

/** Fetch All in the status bar while it runs ("Linyra: fetching 23/68…"): how many are done. */
export function fetchProgress(done: number, total: number): string {
  return localize("fetching {0}/{1}…", done, total);
}

/** Fetch All's result, when every fetch succeeded: the ↓ marks it leaves, in one line. */
export function fetchSummary(total: number, behind: number): string {
  const repos = localize("{0} {1}", total, localize(total === 1 ? "repository" : "repositories"));
  const found = behind === 0 ? localize("nothing to pull") : localize("{0} behind {1} upstream", behind, localize(behind === 1 ? "its" : "their"));
  return localize("Linyra: fetched {0} · {1}", repos, found);
}

/**
 * Pull All Behind: the commits the last fetch brought, into the current branch. A merge with
 * the upstream, fast-forward only: no fetch, never a merge commit, and git refuses (changing
 * nothing) when local changes touch the incoming files. Hooks and LFS may still reach the network.
 */
export function pullArgs(): string[] {
  // Pinned off: merge.autoStash would stash local edits, fast-forward and apply them back with
  // conflict markers (and exit 0); submodule.recurse would check out submodules too.
  return ["-c", "merge.autoStash=false", "-c", "submodule.recurse=false", "merge", "--ff-only", "--quiet", "@{upstream}"];
}

/** Behind and not ahead: a fast-forward. Behind and ahead: diverged, left to the user. */
export function pullPlan(repoIds: readonly string[], sync: Readonly<Record<string, AheadBehind>>): { pull: string[]; diverged: string[] } {
  const behind = behindRepos(repoIds, sync);
  return { pull: behind.filter((id) => sync[id].ahead === 0), diverged: behind.filter((id) => sync[id].ahead > 0) };
}

/** Why git refused a fast-forward, in a few words. */
export function pullReason(message: string): string {
  if (/untracked working tree files would be overwritten/i.test(message)) return localize("untracked files in the way");
  if (/would be overwritten/i.test(message)) return localize("local changes to the same files");
  if (/fast-forward/i.test(message)) return localize("it has diverged from its upstream");
  return message.trim();
}

export function pullSummary(pulled: number): string {
  return localize("Linyra: pulled {0} {1}", pulled, localize(pulled === 1 ? "repository" : "repositories"));
}
