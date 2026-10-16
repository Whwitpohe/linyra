import { fileTree, type TreeNode } from "./fileTree";
import { commitKey, UNCOMMITTED, type ChangeStatus, type Commit, type FileChange } from "./types";
import { absoluteTime, relativeTime } from "./webview/view";

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
export interface FileDesc extends Base {
  kind: "file"; path: string; file: FileChange; openable: boolean; owner: Owner;
  /** All Files: a file the commit did not change (it opens as it was, not as a diff). */
  unchanged?: boolean;
}
export type NodeDesc = CommitDesc | FolderDesc | FileDesc;

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
  return status ? DECORATIONS[status] : undefined;
}

export const NO_SELECTION = "Select a commit in the Log to see its changed files.";
export const LOADING = "Loading changed files…";
export const NO_FILES = "This commit changes no files.";

export function firstOpenable(files: readonly FileChange[]): FileChange | undefined {
  return files.find((f) => f.added !== null);
}

/** A changed file's description: +/− counts, "new", "binary", a rename's old name, "· staged". */
export function stat(f: FileChange): string {
  if (f.untracked) return "new";
  if (f.added === null) return f.staged ? "binary · staged" : "binary";
  const counts = `+${f.added} −${f.deleted}`;
  const shown = f.oldPath ? `← ${f.oldPath}  ${counts}` : counts;
  return f.staged ? `${shown} · staged` : shown;
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
  if (!s) return { message: NO_SELECTION, roots: [] };
  const c = s.commit;
  const base = commitKey(c);
  const tooltip = `${s.message || c.subject}\n\n${c.author} <${c.email}> · ${absoluteTime(c.time)} · ${s.repoName}\n${c.sha}`;
  const owner = { repoId: c.repoId, sha: c.sha, parent: c.parents[0] ?? null };
  const children = s.status === "ready" ? describeNodes(fileTree(s.files), "", base, owner) : [];
  const pending = c.sha === UNCOMMITTED;
  const n = s.files.length;
  const description = pending ? `${n} ${n === 1 ? "file" : "files"} · not committed` : `${c.sha.slice(0, 7)} · ${c.author} · ${relativeTime(now, c.time)}`;
  // Uncommitted work (the Log's Uncommitted side): one repository, review only.
  const root: CommitDesc = {
    kind: "commit", id: base, label: pending ? s.repoName : c.subject, description,
    tooltip: pending ? `${s.repoName}: changes since the last commit, staged or not. Stage, unstage and commit in the Uncommitted view.` : tooltip, children,
  };
  const message =
    s.status === "loading" ? LOADING
    : s.status === "error" ? `Could not read this commit: ${s.error ?? "unknown error"}`
    : s.files.length === 0 ? NO_FILES
    : undefined;
  return { message, roots: [root] };
}

/** The Changes view's description (next to its title): which repository and commit, or "uncommitted". */
export function viewDescription(s: ChangesState | null): string {
  if (!s) return "";
  const what = s.commit.sha === UNCOMMITTED ? "uncommitted" : s.commit.sha.slice(0, 7);
  const n = s.status === "ready" ? s.files.length : 0;
  return [s.repoName, what, ...(n > 0 ? [`${n} ${n === 1 ? "file" : "files"}`] : [])].join(" · ");
}
