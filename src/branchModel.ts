import { isValidRef } from "./filterModel";

export interface Branch {
  ref: string;
  name: string;
  kind: "local" | "remote";
  sha: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  remote?: string;
  remoteBranch?: string;
}

export interface Branches {
  branches: Branch[];
  remotes: string[];
  current?: string;
}

export interface BranchSidebarState {
  mode: "repos" | "branches";
  expanded: string[];
  favorites: string[];
}

export const DEFAULT_BRANCH_SIDEBAR: BranchSidebarState = { mode: "repos", expanded: ["local", "remote"], favorites: [] };
export const branchKey = (repoId: string, ref: string) => `${repoId}\0${ref}`;
export const branchGroupKey = (kind: "local" | "remote", repoId: string) => `${kind}\0${repoId}`;
/** Remote refs remain unambiguous even when a local branch uses the same name. */
export const branchRevision = (branch: Branch, data: Branches): string => branch.kind === "remote" && data.branches.some((b) => b.kind === "local" && b.name === branch.name) ? branch.ref : branch.name;
export const branchArgs = (): string[] => ["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(symref)", "refs/heads", "refs/remotes"];

export function parseBranches(output: string, remotes: string[]): Branches {
  const branches: Branch[] = [];
  const remoteNames = [...remotes].sort((a, b) => b.length - a.length);
  for (const line of output.split("\n")) {
    const [ref, sha, head, upstream, track = "", symbolic] = line.replace(/\r$/, "").split("\0");
    const match = /^refs\/(heads|remotes)\/(.+)$/.exec(ref);
    if (!match || symbolic || !isValidRef(match[2])) continue;
    const kind = match[1] === "heads" ? "local" : "remote";
    const name = match[2];
    const remote = kind === "remote" ? remoteNames.find((r) => name.startsWith(`${r}/`)) : undefined;
    branches.push({ ref, sha, name, kind, current: head === "*", upstream: upstream || undefined,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      ...(remote ? { remote, remoteBranch: name.slice(remote.length + 1) } : {}) });
  }
  return { branches, remotes, current: branches.find((b) => b.current)?.name };
}

export function sidebarState(value: unknown): BranchSidebarState {
  const state = value as Partial<BranchSidebarState> | undefined;
  const strings = (v: unknown, fallback: string[]) => Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length < 4096))].slice(0, 1000) : fallback;
  return { mode: state?.mode === "branches" ? "branches" : "repos", expanded: strings(state?.expanded, DEFAULT_BRANCH_SIDEBAR.expanded), favorites: strings(state?.favorites, []) };
}

export function newBranchProblem(name: string, branches: readonly Branch[], except?: string): string | undefined {
  if (!isValidRef(name.trim())) return "Enter a valid branch name.";
  if (branches.some((b) => b.kind === "local" && b.name !== except && b.name === name.trim())) return "A local branch with this name already exists.";
  return undefined;
}

/** Explicit argv, never shell text; callers resolve the branch from a fresh ref read. */
export const branchCommands = {
  checkout: (b: Branch) => ["checkout", b.name, "--"],
  create: (b: Branch, name: string) => ["checkout", "-b", name, b.ref, "--"],
  track: (b: Branch, name: string) => ["checkout", "--track", "-b", name, b.ref, "--"],
  rename: (b: Branch, name: string) => ["branch", "-m", "--", b.name, name],
  delete: (b: Branch) => ["branch", "-d", "--", b.name],
  merge: (b: Branch) => ["merge", "--no-edit", "--", b.ref],
  rebase: (b: Branch) => ["rebase", "--no-autostash", "--", b.ref],
  worktree: (b: Branch, name: string, destination: string) => ["worktree", "add", "-b", name, "--", destination, b.ref],
};
