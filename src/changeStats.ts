// The Log's Changes column: each commit's files changed and lines added and deleted, read for the
// rows on screen with one git process per repository. Pure: no vscode import.

export interface CommitStats { files: number; added: number; deleted: number }

/** How the Changes column draws a commit's stats (the Log's ⋯ menu), as GitLens's Commit Graph offers them. */
export type ChangesMode = "off" | "numbers" | "squares" | "bar" | "bipolar";
export const CHANGES_MODES: readonly ChangesMode[] = ["off", "numbers", "squares", "bar", "bipolar"];
export const isChangesMode = (v: unknown): v is ChangesMode => typeof v === "string" && (CHANGES_MODES as readonly string[]).includes(v);

/**
 * The listed commits (their ids on stdin, one per line), each with its shortstat. A merge is
 * diffed against its first parent, as the Changes view lists its files; nothing is walked.
 */
export const statsArgs = (): string[] => ["log", "--no-walk=unsorted", "--stdin", "--first-parent", "-m", "--format=%x1e%H", "--shortstat", "--no-color"];

const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

/** `git log --format=%x1e%H --shortstat` output: id → stats. A commit with no diff (an empty commit) has zeros. */
export function parseStats(stdout: string): Map<string, CommitStats> {
  const out = new Map<string, CommitStats>();
  for (const record of stdout.split("\x1e")) {
    const sha = /^[0-9a-f]{40,64}/.exec(record)?.[0];
    if (!sha) continue;
    const m = SHORTSTAT.exec(record);
    out.set(sha, m ? { files: Number(m[1]), added: Number(m[2] ?? 0), deleted: Number(m[3] ?? 0) } : { files: 0, added: 0, deleted: 0 });
  }
  return out;
}

/** The commits worth asking for: valid ids of known repositories, grouped by repository, each once. */
export function statsRequests(commits: readonly unknown[], known: (repoId: string) => boolean, max = 400): Map<string, string[]> {
  const byRepo = new Map<string, Set<string>>();
  let n = 0;
  for (const c of commits) {
    if (n >= max) break;
    if (!c || typeof c !== "object") continue;
    const { repoId, sha } = c as { repoId?: unknown; sha?: unknown };
    if (typeof repoId !== "string" || typeof sha !== "string" || !/^[0-9a-f]{40,64}$/.test(sha) || !known(repoId)) continue;
    const set = byRepo.get(repoId) ?? new Set<string>();
    if (!set.has(sha)) { set.add(sha); n++; }
    byRepo.set(repoId, set);
  }
  return new Map([...byRepo].map(([repo, shas]) => [repo, [...shas]]));
}
