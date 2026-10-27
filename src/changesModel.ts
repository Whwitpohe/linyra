import { localize } from "./i18n";
import { fileTree, type TreeNode } from "./fileTree";
import { commitKey, UNCOMMITTED, type ChangeStatus, type Commit, type FileChange } from "./types";
import { absoluteTime, relativeTime } from "./webview/view";
import type { CommitReferences } from "./commitReferences";

export type ChangesStatus = "loading" | "ready" | "error";

export interface ChangesState {
  commit: Commit;
  repoRoot: string;
  repoName: string;
  status: ChangesStatus;
  files: FileChange[];
  /** Full commit message; "" until loaded. */
  message: string;
  error?: string;
  /** File history: the file to highlight in the tree. */
  focusPath?: string;
  /** Uncommitted work VS Code's Git can change: its rows offer Discard, Stage, Unstage, Commit. */
  discardable?: boolean;
  /** Uncommitted work: the paths with a staged change (their rows offer Unstage). */
  stagedPaths?: readonly string[];
  references?: CommitReferences;
  repoAccent?: number;
}

/** Which repository and revision a file node belongs to, for opening its diff. */
export interface Owner {
  repoId: string;
  sha: string;
  parent: string | null;
}

interface Base {
  /** Stable across re-renders so VS Code keeps each folder's expand state. */
  id: string;
  label: string;
  description: string;
  tooltip: string;
}
export interface CommitDesc extends Base { kind: "commit"; children: NodeDesc[] }
export interface FolderDesc extends Base {
  kind: "folder"; path: string; children: NodeDesc[];
  /** All Files: how many changed files are under it (it opens when there are some). */
  changedCount?: number;
}
export interface RepoDesc extends Base { kind: "repo"; repoId: string; accent: number; children: NodeDesc[] }
export interface FileDesc extends Base {
  kind: "file"; path: string; file: FileChange; openable: boolean; owner: Owner;
  /** Combined Changes: how its diff opens. */
  combined?: CombinedOpen;
  /** All Files: a file the commit did not change (it opens as it was, not as a diff). */
  unchanged?: boolean;
}
export type NodeDesc = CommitDesc | RepoDesc | FolderDesc | FileDesc;

export interface Decoration {
  badge: string;
  /** A theme color id, so the tree uses the user's own git colors. */
  color: string;
  tooltip: string;
}

const DECORATIONS: Record<ChangeStatus, Decoration> = {
  A: { badge: "A", color: "gitDecoration.addedResourceForeground", tooltip: "Added" },
  M: { badge: "M", color: "gitDecoration.modifiedResourceForeground", tooltip: "Modified" },
  D: { badge: "D", color: "gitDecoration.deletedResourceForeground", tooltip: "Deleted" },
  R: { badge: "R", color: "gitDecoration.renamedResourceForeground", tooltip: "Renamed" },
  C: { badge: "C", color: "gitDecoration.addedResourceForeground", tooltip: "Copied" },
  T: { badge: "T", color: "gitDecoration.modifiedResourceForeground", tooltip: "Type changed" },
};

/** What the commit did to a file, as a native file decoration (color + badge). */
export function decorationFor(status: ChangeStatus | undefined): Decoration | undefined {
  const decoration = status ? DECORATIONS[status] : undefined;
  return decoration ? { ...decoration, tooltip: localize(decoration.tooltip) } : undefined;
}

export const NO_SELECTION = "Select a commit in the Log to see its changed files.";
export const LOADING = "Loading changed files…";
export const NO_FILES = "This commit changes no files.";

export function firstOpenable(files: readonly FileChange[]): FileChange | undefined {
  return files.find((f) => f.added !== null);
}

/** A changed file's description: +/− counts, "new", "binary", a rename's old name, "· staged". */
export function stat(f: FileChange): string {
  if (f.untracked) return localize("new");
  if (f.added === null) return f.staged ? localize("binary · staged") : localize("binary");
  const counts = `+${f.added} −${f.deleted}`;
  const shown = f.oldPath ? `← ${f.oldPath}  ${counts}` : counts;
  return f.staged ? localize("{0} · staged", shown) : shown;
}

function describeNodes(nodes: readonly TreeNode[], parent: string, base: string, owner: Owner): NodeDesc[] {
  return nodes.map((n): NodeDesc => {
    if (n.kind === "folder") {
      const path = parent ? `${parent}/${n.name}` : n.name;
      return { kind: "folder", id: `${base}/d:${path}`, label: n.name, description: String(n.count), tooltip: path, path, children: describeNodes(n.children, path, base, owner) };
    }
    const f = n.file;
    return {
      kind: "file", id: `${base}/f:${f.path}`, label: n.name, description: stat(f),
      tooltip: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path, path: f.path, file: f, openable: f.added !== null, owner,
    };
  });
}

/** Everything the Changes tree shows, as plain data. The VS Code adapter only maps it to TreeItems. */
export function describeChanges(s: ChangesState | null, now: number): { message: string | undefined; roots: NodeDesc[] } {
  if (!s) return { message: localize(NO_SELECTION), roots: [] };
  const c = s.commit;
  const base = commitKey(c);
  const tooltip = `${s.message || c.subject}\n\n${c.author} <${c.email}> · ${absoluteTime(c.time)} · ${s.repoName}\n${c.sha}`;
  const owner = { repoId: c.repoId, sha: c.sha, parent: c.parents[0] ?? null };
  const children = s.status === "ready" ? describeNodes(fileTree(s.files), "", base, owner) : [];
  const pending = c.sha === UNCOMMITTED;
  const n = s.files.length;
  const description = pending ? localize("{0} {1} · not committed", n, localize(n === 1 ? "file" : "files")) : `${c.sha.slice(0, 7)} · ${c.author} · ${relativeTime(now, c.time)}`;
  // Uncommitted work (the Log's Uncommitted side): one repository, review only.
  const root: CommitDesc = {
    kind: "commit", id: base, label: pending ? s.repoName : c.subject, description,
    tooltip: pending ? localize("{0}: changes since the last commit, staged or not. Stage, unstage and commit in the Uncommitted view.", s.repoName) : tooltip, children,
  };
  const message =
    s.status === "loading" ? localize(LOADING)
    : s.status === "error" ? localize("Could not read this commit: {0}", s.error ?? localize("unknown error"))
    : s.files.length === 0 ? localize(NO_FILES)
    : undefined;
  return { message, roots: [root] };
}

/** The Changes view's description (next to its title): which repository and commit, or "uncommitted". */
export function viewDescription(s: ChangesState | null): string {
  if (!s) return "";
  const what = s.commit.sha === UNCOMMITTED ? localize("uncommitted") : s.commit.sha.slice(0, 7);
  const n = s.status === "ready" ? s.files.length : 0;
  return [s.repoName, what, ...(n > 0 ? [localize("{0} {1}", n, localize(n === 1 ? "file" : "files"))] : [])].join(" · ");
}

/** Combined Changes: how one file's diff opens (spec section 4). */
export interface CombinedOpen {
  repoId: string;
  path: string;
  status: ChangeStatus;
  /** The first parent of the oldest selected commit that touched it; null for a root commit. */
  beforeRef: string | null;
  beforePath: string;
  /** The selected commits that touched it, oldest first. */
  shas: string[];
  /** fast: beforeRef ↔ last. merge: the selected commits taken out of last. fallback: beforeRef ↔ last, labeled. */
  mode: "fast" | "merge" | "fallback";
  reason?: "conflict" | "binary" | "too large";
  /** Unselected commits whose changes reach it, oldest first. */
  included: string[];
}

export interface CombinedRepo {
  repoId: string;
  repoName: string;
  accent: number;
  /** Its selected commits, oldest first. */
  commits: Commit[];
  files: CombinedOpen[];
}

export interface CombinedState {
  status: ChangesStatus;
  repos: CombinedRepo[];
  noNetChange: string[];
  /** How many commits are selected. */
  count: number;
  /** Unselected commits' subjects, for the ⚠ tooltips. */
  unselected: Record<string, string>;
  error?: string;
}

const plural = (n: number, one: string, many: string) => localize("{0} {1}", n, localize(n === 1 ? one : many));
const short = (sha: string, n = 7) => sha.slice(0, n);

/** The Changes view with several commits: a root per repository, each changed file once. */
export function describeCombined(s: CombinedState): { message: string | undefined; roots: NodeDesc[]; description: string } {
  const description = `${plural(s.count, "commit", "commits")} · ${plural(s.repos.length, "repository", "repositories")}`;
  const roots = s.repos.map((r): RepoDesc => {
    const base = `combined/${r.repoId}`;
    const byPath = new Map(r.files.map((f) => [f.path, f]));
    // No +/− counts here: a file's description names the selected commits that touched it.
    const changes: FileChange[] = r.files.map((f) => (f.beforePath !== f.path ? { path: f.path, oldPath: f.beforePath, status: f.status, added: 0, deleted: 0 } : { path: f.path, status: f.status, added: 0, deleted: 0 }));
    const fix = (nodes: NodeDesc[]): NodeDesc[] => nodes.map((n): NodeDesc => {
      if (n.kind !== "file") return n.kind === "folder" ? { ...n, children: fix(n.children) } : n;
      const o = byPath.get(n.path)!;
      const shas = o.shas.map((x) => short(x, 4)).join(" · ");
      const warn = o.mode === "fallback";
      const tooltip = !warn ? n.tooltip
        : o.reason !== "conflict" ? localize("Shown as one diff from before the first selected commit: the file is {0}", localize(o.reason === "binary" ? "binary" : "too large"))
        : localize("Includes changes from {0}: {1}", plural(o.included.length, "unselected commit", "unselected commits"), o.included.map((x) => localize("{0} {1}", short(x), s.unselected[x] ?? "").trim()).join("; "));
      return { ...n, description: warn ? `⚠ ${shas}` : shas, tooltip, owner: { repoId: r.repoId, sha: o.shas[o.shas.length - 1], parent: null }, combined: o };
    });
    const owner = { repoId: r.repoId, sha: "", parent: null };
    return {
      kind: "repo", id: base, repoId: r.repoId, accent: r.accent, label: r.repoName, description: plural(r.commits.length, "commit", "commits"),
      tooltip: r.commits.map((c) => `${short(c.sha)} ${c.subject} · ${c.author} · ${absoluteTime(c.time)}`).join("\n"),
      children: fix(describeNodes(fileTree(changes), "", base, owner)),
    };
  });
  const message =
    s.status === "loading" ? localize(LOADING)
    : s.status === "error" ? localize("Could not read these commits: {0}", s.error ?? localize("unknown error"))
    : s.noNetChange.length > 0 ? localize("{0} with no net change: {1}", plural(s.noNetChange.length, "file", "files"), s.noNetChange.join(", "))
    : roots.length === 0 ? localize("These commits change no files.")
    : undefined;
  return { message, roots, description };
}

/** The diff editor's title for a Combined Changes file. */
export function combinedTitle(o: CombinedOpen, repoName: string): string {
  const name = o.path.split("/").pop() ?? o.path;
  const first = short(o.shas[0]);
  const last = short(o.shas[o.shas.length - 1]);
  if (o.mode === "fallback") {
    const why = o.reason === "conflict" ? localize("includes {0}", plural(o.included.length, "unselected commit", "unselected commits")) : localize(o.reason ?? "conflict");
    return `${name} (${first}^ ↔ ${last}, ${why})`;
  }
  return o.shas.length === 1 ? `${name} (${last}) — ${repoName}` : localize("{0} ({1} selected commits)", name, o.shas.length);
}
