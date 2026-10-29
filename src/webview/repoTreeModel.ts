import { branchGroupKey, branchKey, type Branch, type Branches, type BranchSidebarState } from "../branchModel";
import type { ResolvedProfile } from "../profileModel";
import { stashLabel, type Stash } from "../stashModel";
import { worktreeLabel, type Worktree } from "../worktreeModel";
import type { Repo } from "../types";
import type { Operation } from "../repoMarkModel";
import { fuzzyMatch, paneRows, type PaneRow } from "./repoPaneModel";

/**
 * The Repositories pane as one tree, as the JetBrains Branches panel groups a multi-root project:
 * each repository (ticked or not) opens onto its Local, Remote and Tags groups. The rows above
 * the repositories (All, profiles, Save) stay as they were.
 */
export type TreeRow =
  | (PaneRow & { key: string; depth: 0; expanded?: boolean })
  | { kind: "group"; key: string; depth: 1; repo: Repo; group: "local" | "remote" | "tag" | "stash" | "worktree"; label: string; expanded: boolean }
  | { kind: "remote"; key: string; depth: 2; repo: Repo; label: string; expanded: boolean }
  | { kind: "branch"; key: string; depth: 2 | 3; repo: Repo; branch: Branch; label: string; favorite: boolean; parent: string }
  | { kind: "stash"; key: string; depth: 2; repo: Repo; stash: Stash; label: string; parent: string }
  | { kind: "worktree"; key: string; depth: 2; repo: Repo; worktree: Worktree; label: string; parent: string }
  | { kind: "message"; key: string; depth: 1 | 2; repo: Repo; label: string }
  | { kind: "operation"; key: string; depth: 1; repoId: string; operation: Operation; conflicts: number; child: boolean };

/** One repository's branch listing as the pane holds it. */
export interface BranchTreeData { data?: Branches; loading?: boolean; error?: string }

export const repoTreeKey = (repoId: string) => `repo\0${repoId}`;
const GROUPS = [["local", "Local"], ["remote", "Remote"], ["tag", "Tags"]] as const;

/** Repositories to read branches for: the opened ones, or all of them while searching (branch names are searched too). */
export function wantedBranchData(repos: readonly Repo[], state: BranchSidebarState, query: string): Repo[] {
  const open = new Set(state.expanded);
  return query.trim() ? [...repos] : repos.filter((r) => open.has(repoTreeKey(r.id)));
}

export function treeRows(repos: readonly Repo[], query: string, profiles: readonly ResolvedProfile[], repoIds: readonly string[] | null,
  data: ReadonlyMap<string, BranchTreeData>, state: BranchSidebarState): TreeRow[] {
  const q = query.trim().toLowerCase();
  const open = new Set(state.expanded), favorites = new Set(state.favorites);
  const hit = (b: Branch) => b.name.toLowerCase().includes(q);
  const byName = new Set(repos.filter((r) => q && fuzzyMatch(q, r.name)).map((r) => r.id));
  const byBranch = new Set(q ? repos.filter((r) => data.get(r.id)?.data?.branches.some(hit)).map((r) => r.id) : []);
  const base = paneRows(repos, query, profiles, repoIds);
  // A repository found only by one of its branch names follows those found by name.
  const extra = repos.filter((r) => byBranch.has(r.id) && !byName.has(r.id)).map((r): PaneRow => ({ kind: "repo", id: r.id, name: r.name }));
  const rows: TreeRow[] = [];
  for (const row of [...base, ...extra]) {
    if (row.kind !== "repo") {
      rows.push({ ...row, key: row.kind === "profile" ? `profile\0${row.profile.name}` : row.kind, depth: 0 });
      continue;
    }
    const repo = repos.find((r) => r.id === row.id)!;
    const key = repoTreeKey(repo.id);
    const expanded = open.has(key) || byBranch.has(repo.id);
    rows.push({ ...row, key, depth: 0, expanded });
    if (!expanded) continue;
    const item = data.get(repo.id);
    if (!item?.data) {
      rows.push({ kind: "message", key: `${key}\0status`, depth: 1, repo, label: item?.error ?? "Reading branches…" });
      continue;
    }
    // Searching by a branch name lists only the matches; a repository found by its own name lists everything.
    const all = item.data.branches.filter((b) => !q || byName.has(repo.id) || hit(b))
      .sort((a, b) => Number(b.current) - Number(a.current) || Number(favorites.has(branchKey(repo.id, b.ref))) - Number(favorites.has(branchKey(repo.id, a.ref))) || a.name.localeCompare(b.name));
    const stashes = (item.data.stashes ?? []).filter((s) => !q || byName.has(repo.id) || stashLabel(s).toLowerCase().includes(q));
    // The repository's other worktrees (its own folder is the row above).
    const worktrees = (item.data.worktrees ?? []).filter((w) => !w.current && (!q || byName.has(repo.id) || worktreeLabel(w).toLowerCase().includes(q)));
    if (!all.length && !stashes.length && !worktrees.length) {
      rows.push({ kind: "message", key: `${key}\0empty`, depth: 1, repo, label: "No branches" });
      continue;
    }
    for (const [group, label] of GROUPS) {
      const branches = all.filter((b) => b.kind === group);
      if (!branches.length) continue;
      const groupKey = branchGroupKey(group, repo.id);
      const groupOpen = !!q || open.has(groupKey);
      rows.push({ kind: "group", key: groupKey, depth: 1, repo, group, label, expanded: groupOpen });
      if (!groupOpen) continue;
      const branchRow = (b: Branch, depth: 2 | 3, parent: string): TreeRow => ({ kind: "branch", key: branchKey(repo.id, b.ref), depth, repo, branch: b,
        label: group === "remote" ? b.remoteBranch ?? b.name : b.name, favorite: favorites.has(branchKey(repo.id, b.ref)), parent });
      if (group !== "remote") {
        for (const b of branches) rows.push(branchRow(b, 2, groupKey));
        continue;
      }
      for (const remote of [...new Set(branches.map((b) => b.remote ?? b.name.split("/")[0]))]) {
        const remoteKey = `${groupKey}\0${remote}`;
        const remoteOpen = !!q || open.has(remoteKey);
        rows.push({ kind: "remote", key: remoteKey, depth: 2, repo, label: remote, expanded: remoteOpen });
        if (remoteOpen) for (const b of branches.filter((x) => (x.remote ?? x.name.split("/")[0]) === remote)) rows.push(branchRow(b, 3, remoteKey));
      }
    }
    // Stashes, as the JetBrains Git window lists them: newest first, only when there are any.
    if (stashes.length) {
      const stashKey = branchGroupKey("stash", repo.id);
      const stashOpen = !!q || open.has(stashKey);
      rows.push({ kind: "group", key: stashKey, depth: 1, repo, group: "stash", label: "Stashes", expanded: stashOpen });
      if (stashOpen) for (const s of stashes) rows.push({ kind: "stash", key: `${stashKey}\0${s.ref}`, depth: 2, repo, stash: s, label: stashLabel(s), parent: stashKey });
    }
    // Worktrees, only when the repository has linked ones: open, reveal or remove each.
    if (worktrees.length) {
      const wtKey = branchGroupKey("worktree", repo.id);
      const wtOpen = !!q || open.has(wtKey);
      rows.push({ kind: "group", key: wtKey, depth: 1, repo, group: "worktree", label: "Worktrees", expanded: wtOpen });
      if (wtOpen) for (const w of worktrees) rows.push({ kind: "worktree", key: `${wtKey}\0${w.path}`, depth: 2, repo, worktree: w, label: worktreeLabel(w), parent: wtKey });
    }
  }
  return rows;
}

/**
 * Expand All: every repository open on its Local branches. Remote and Tags keep what the user
 * chose: opening every remote of every repository would bury the list.
 */
export function expandAll(repos: readonly Repo[], state: BranchSidebarState): BranchSidebarState {
  const expanded = new Set(state.expanded);
  for (const r of repos) {
    expanded.add(repoTreeKey(r.id));
    expanded.add(branchGroupKey("local", r.id));
  }
  return { ...state, expanded: [...expanded] };
}

/** Collapse All: every repository, group and remote closed; favorites stay. */
export function collapseAll(state: BranchSidebarState): BranchSidebarState {
  return { ...state, expanded: [] };
}

/**
 * A merge, rebase, cherry-pick, revert or patch series stopped in a repository: a row right under
 * it that says so, its next step one Enter away (Resolve while files conflict, else Continue).
 * It shows under a collapsed repository too (what stopped stays in sight); there it is not the
 * repository's child (`child`: a collapsed tree item shows none).
 */
export function withOperations(rows: readonly TreeRow[], stopped: ReadonlyMap<string, { operation: Operation; conflicts: number }>): TreeRow[] {
  if (stopped.size === 0) return [...rows];
  const out: TreeRow[] = [];
  for (const row of rows) {
    out.push(row);
    const op = row.kind === "repo" ? stopped.get(row.id) : undefined;
    if (row.kind === "repo" && op) out.push({ kind: "operation", key: `op\0${row.id}`, depth: 1, repoId: row.id, operation: op.operation, conflicts: op.conflicts, child: row.expanded === true });
  }
  return out;
}

/** The row a child belongs to (Left arrow): the nearest row above it at a smaller depth. */
export function parentIndex(rows: readonly TreeRow[], index: number): number {
  const depth = rows[index]?.depth ?? 0;
  for (let i = index - 1; i >= 0; i--) if (rows[i].depth < depth) return i;
  return -1;
}
