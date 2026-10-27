import { branchGroupKey, branchKey, type Branch, type Branches, type BranchSidebarState } from "../branchModel";
import type { Repo } from "../types";

export interface BranchTreeData { data?: Branches; loading?: boolean; error?: string }
export interface BranchRow {
  key: string;
  kind: "group" | "repo" | "remote" | "branch" | "message";
  label: string;
  depth: number;
  parent?: string;
  expanded?: boolean;
  repo?: Repo;
  branch?: Branch;
  favorite?: boolean;
}

/** The same repo/ref can be displayed under a remote without losing its full identity. */
export function branchRows(repos: readonly Repo[], data: ReadonlyMap<string, BranchTreeData>, state: BranchSidebarState, query: string): BranchRow[] {
  const q = query.trim().toLowerCase(), open = new Set(state.expanded), favorites = new Set(state.favorites);
  const rows: BranchRow[] = [];
  const match = (text: string) => text.toLowerCase().includes(q);
  for (const kind of ["local", "remote"] as const) {
    rows.push({ key: kind, kind: "group", label: kind === "local" ? "Local" : "Remote", depth: 0, expanded: q !== "" || open.has(kind) });
    if (!q && !open.has(kind)) continue;
    for (const repo of repos) {
      const item = data.get(repo.id);
      const branches = (item?.data?.branches ?? []).filter((b) => b.kind === kind && (!q || match(repo.name) || match(b.name)))
        .sort((a, b) => Number(b.current) - Number(a.current) || Number(favorites.has(branchKey(repo.id, b.ref))) - Number(favorites.has(branchKey(repo.id, a.ref))) || a.name.localeCompare(b.name));
      if (q && item?.data && branches.length === 0 && !match(repo.name)) continue;
      const key = branchGroupKey(kind, repo.id);
      rows.push({ key, kind: "repo", label: repo.name, repo, depth: 1, parent: kind, expanded: q !== "" || open.has(key) });
      if (!q && !open.has(key)) continue;
      const add = (b: Branch, depth: number, parent: string) => rows.push({ key: branchKey(repo.id, b.ref), kind: "branch", label: kind === "remote" ? b.remoteBranch ?? b.name : b.name,
        repo, branch: b, depth, parent, favorite: favorites.has(branchKey(repo.id, b.ref)) });
      if (!item?.data) {
        rows.push({ key: `${key}\0status`, kind: "message", label: item?.error ?? "Reading branches…", depth: 2, parent: key, repo });
      } else if (branches.length === 0) {
        rows.push({ key: `${key}\0empty`, kind: "message", label: "No branches", depth: 2, parent: key });
      } else if (kind === "local") branches.forEach((b) => add(b, 2, key));
      else {
        const remotes = [...new Set(branches.map((b) => b.remote ?? b.name.split("/")[0]))];
        for (const remote of remotes) {
          const remoteKey = `${key}\0${remote}`;
          rows.push({ key: remoteKey, kind: "remote", label: remote, repo, depth: 2, parent: key, expanded: q !== "" || open.has(remoteKey) });
          if (q || open.has(remoteKey)) branches.filter((b) => (b.remote ?? b.name.split("/")[0]) === remote).forEach((b) => add(b, 3, remoteKey));
        }
      }
    }
  }
  return rows;
}
