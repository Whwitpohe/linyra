// A repository's worktrees, as the Repo List's Worktrees group lists them. Pure: no vscode, no fs
// (repoHead.ts reads them from the git dir's files).

export interface Worktree {
  /** The worktree's folder. */
  path: string;
  /** Its checked-out branch; null when HEAD is detached there. */
  branch: string | null;
  /** A detached HEAD's commit, short. */
  detached?: string;
  /** The repository's main working tree (it cannot be removed). */
  main: boolean;
  /** This repository's own folder: not listed. */
  current: boolean;
  /** git worktree lock: git will not remove or prune it. */
  locked?: boolean;
  /** Its folder is gone: git worktree prune forgets it. */
  missing?: boolean;
}

/** The folder's last name, whichever separator the path uses. */
export function folderName(p: string): string {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
}

/** "acme-web-hotfix · hotfix": the row's label. */
export function worktreeLabel(w: Worktree): string {
  return `${folderName(w.path)} · ${w.branch ?? w.detached ?? "HEAD"}`;
}

/** git worktree remove's refusal of a worktree with local changes (its English words: LC_ALL=C). */
export function hasLocalChanges(message: string): boolean {
  return /contains modified or untracked files|use --force to delete it/i.test(message);
}

export const worktreeCommands = {
  remove: (path: string, force: boolean) => ["worktree", "remove", ...(force ? ["--force"] : []), "--", path],
  prune: () => ["worktree", "prune"],
};
