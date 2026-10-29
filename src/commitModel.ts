import { localize } from "./i18n";
// The Commit side bar, as the Commit tool window of the JetBrains IDEs shows uncommitted work:
// Changes and Unversioned Files, each by repository and folder, every row with a checkbox, and a
// commit of the checked files only. Pure: no vscode import.
import { fileTree, type TreeNode } from "./fileTree";
import type { ChangeStatus, FileChange } from "./types";
import { NO_UNCOMMITTED_VIEW, type RepoWork } from "./uncommittedModel";

/** One changed path of a repository. Its staged and unstaged halves are one row: a commit takes the file as it is. */
export interface CommitFile {
  path: string;
  /** A staged rename's old name: the commit takes both. */
  oldPath?: string;
  status?: ChangeStatus;
  /** Not tracked yet: Unversioned Files, unchecked until the user checks it. */
  untracked: boolean;
  /** Part of it is staged (shown, never needed: the commit takes the working tree's file). */
  staged: boolean;
  /** Part of it is not staged: it is in the Changes half (Open File and diffs read the working tree). */
  changed: boolean;
}

export type Check = "on" | "off" | "mixed";
export type ListId = "changes" | "unversioned";

export interface CommitRow {
  id: string;
  kind: "list" | "repo" | "folder" | "file";
  label: string;
  description: string;
  tooltip: string;
  check: Check;
  repoId?: string;
  path?: string;
  oldPath?: string;
  status?: ChangeStatus;
  untracked?: boolean;
  /** A file's half that has the working tree's file: Open File and File History read it. */
  group?: "staged" | "changes";
  /** The repository's color in the Log. */
  accent?: number;
  /** What its menus offer (package.json view/item/context, viewItem). */
  contextValue: string;
  /** Files under the row, and how many of them are checked (a file: 1, and 1 or 0). */
  files: number;
  checked: number;
  children?: CommitRow[];
}

/** The user's checks that differ from the default (tracked files checked, new files not), by fileKey. */
export type Choices = ReadonlyMap<string, boolean>;

const plural = (n: number, one: string, many = `${one}s`) => localize("{0} {1}", n, localize(n === 1 ? one : many));

export const fileKey = (repoId: string, path: string): string => `${repoId}\0${path}`;

/** Each changed path of the repository once, staged and unstaged halves merged. */
export function commitFiles(w: RepoWork): CommitFile[] {
  const byPath = new Map<string, { staged?: FileChange; change?: FileChange }>();
  for (const f of w.staged) byPath.set(f.path, { ...byPath.get(f.path), staged: f });
  for (const f of w.changes) byPath.set(f.path, { ...byPath.get(f.path), change: f });
  return [...byPath].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, { staged, change }]) => ({
    path,
    ...(staged?.oldPath ? { oldPath: staged.oldPath } : {}),
    // Deleted from the working tree after it was staged: the commit deletes it.
    status: change?.status === "D" ? "D" : staged?.status ?? change?.status,
    untracked: change?.untracked === true,
    staged: staged !== undefined,
    changed: change !== undefined,
  }));
}

export function isChecked(choices: Choices, repoId: string, f: CommitFile): boolean {
  return choices.get(fileKey(repoId, f.path)) ?? !f.untracked;
}

function checkOf(checked: number, files: number): Check {
  return checked === 0 ? "off" : checked === files ? "on" : "mixed";
}

/** The counts of the rows below: a list, repository or folder is checked when all its files are. */
function counts(children: readonly CommitRow[]): { files: number; checked: number; check: Check } {
  const files = children.reduce((n, c) => n + c.files, 0), checked = children.reduce((n, c) => n + c.checked, 0);
  return { files, checked, check: checkOf(checked, files) };
}

/** Some files checked: VS Code's checkboxes have no third state, so the description says how many. */
const partly = (c: { files: number; checked: number; check: Check }, all: string) =>
  c.check === "mixed" ? localize("{0} of {1} checked", c.checked, all) : all;

const statusName: Partial<Record<ChangeStatus, string>> = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type changed" };

function describeFiles(nodes: readonly TreeNode[], files: ReadonlyMap<string, CommitFile>, parent: string, base: string, w: RepoWork, choices: Choices): CommitRow[] {
  return nodes.map((n): CommitRow => {
    if (n.kind === "folder") {
      const path = parent ? `${parent}/${n.name}` : n.name;
      const children = describeFiles(n.children, files, path, base, w, choices);
      const c = counts(children);
      return { id: `${base}:d:${path}`, kind: "folder", label: n.name, description: c.check === "mixed" ? `${c.checked}/${c.files}` : String(c.files), tooltip: path,
        repoId: w.repoId, path, children, contextValue: "commitFolder", ...c };
    }
    const f = files.get(n.file.path)!;
    const state = f.untracked ? localize("new") : localize(statusName[f.status ?? "M"] ?? "modified");
    const on = isChecked(choices, w.repoId, f);
    return {
      id: `${base}:f:${f.path}`, kind: "file", label: n.name, description: f.oldPath ? `← ${f.oldPath}` : "", check: on ? "on" : "off", files: 1, checked: on ? 1 : 0,
      tooltip: `${f.oldPath ? `${f.oldPath} → ` : ""}${f.path} · ${state}${f.staged && f.changed ? ` · ${localize("partly staged")}` : ""}`,
      repoId: w.repoId, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.untracked ? "A" : f.status, untracked: f.untracked,
      // Open File and File History want the half that has the working tree's file.
      group: f.changed ? "changes" : "staged",
      contextValue: `commitFile.${f.untracked ? "untracked" : f.status === "D" ? "deleted" : "changed"}`,
    };
  });
}

/**
 * Everything the Commit side bar shows: Changes, then Unversioned Files, each by repository (in
 * Repo List order) and folder. A list, repository or folder is checked when all its files are.
 */
export function describeCommit(works: readonly RepoWork[], choices: Choices, accents: ReadonlyMap<string, number> = new Map(), behind: (repoId: string) => boolean = () => false): {
  roots: CommitRow[]; message: string | undefined; checked: { files: number; repos: number }; total: number;
} {
  const lists: CommitRow[] = [];
  let total = 0;
  for (const [list, label, untracked] of [["changes", localize("Changes"), false], ["unversioned", localize("Unversioned Files"), true]] as const) {
    const repos: CommitRow[] = [];
    for (const w of works) {
      const files = commitFiles(w).filter((f) => f.untracked === untracked);
      if (files.length === 0) continue;
      total += files.length;
      const byPath = new Map(files.map((f) => [f.path, f]));
      const base = `${list}:${w.repoId}`;
      const children = describeFiles(fileTree(files.map((f): FileChange => ({ path: f.path, added: null, deleted: null }))), byPath, "", base, w, choices);
      const c = counts(children);
      repos.push({
        id: base, kind: "repo", label: w.name, description: partly(c, plural(c.files, "file")), repoId: w.repoId, accent: accents.get(w.repoId) ?? 0, children, ...c,
        tooltip: w.canStage ? w.root : localize("{0}: Rollback needs VS Code's Git to have this repository open.", w.name),
        contextValue: `commitRepo${behind(w.repoId) ? ".behind" : ""}`,
      });
    }
    if (repos.length === 0) continue;
    const c = counts(repos);
    lists.push({ id: list, kind: "list", label, description: partly(c, plural(c.files, "file")), tooltip: label, children: repos, contextValue: "commitList", ...c });
  }
  const plan = commitPlan(works, choices);
  return {
    roots: lists, message: lists.length === 0 ? localize(NO_UNCOMMITTED_VIEW) : undefined, total,
    checked: { files: plan.reduce((n, p) => n + p.files, 0), repos: plan.length },
  };
}

/** The files under rows (each once), as repository and path: what a check or a Rollback takes. */
export function filesUnder(rows: readonly CommitRow[]): { repoId: string; path: string }[] {
  const seen = new Set<string>();
  const out: { repoId: string; path: string }[] = [];
  const walk = (r: CommitRow) => {
    if (r.kind === "file") {
      const key = fileKey(r.repoId!, r.path!);
      if (!seen.has(key)) { seen.add(key); out.push({ repoId: r.repoId!, path: r.path! }); }
    } else (r.children ?? []).forEach(walk);
  };
  rows.forEach(walk);
  return out;
}

/** Every row by id, for messages that name rows. */
export function rowsById(roots: readonly CommitRow[]): Map<string, CommitRow> {
  const out = new Map<string, CommitRow>();
  const walk = (r: CommitRow) => { out.set(r.id, r); (r.children ?? []).forEach(walk); };
  roots.forEach(walk);
  return out;
}

/** Check or uncheck the files under rows. Only choices that differ from the default are kept. */
export function setChecked(works: readonly RepoWork[], choices: Choices, rows: readonly CommitRow[], on: boolean): Map<string, boolean> {
  const next = new Map(choices);
  const untracked = new Set(works.flatMap((w) => commitFiles(w).filter((f) => f.untracked).map((f) => fileKey(w.repoId, f.path))));
  for (const { repoId, path } of filesUnder(rows)) {
    const key = fileKey(repoId, path);
    if (on === !untracked.has(key)) next.delete(key);
    else next.set(key, on);
  }
  return next;
}

/** Choices for files no longer listed are forgotten: a file changed again starts from the default. */
export function pruneChoices(works: readonly RepoWork[], choices: Choices): Map<string, boolean> {
  const listed = new Set(works.flatMap((w) => commitFiles(w).map((f) => fileKey(w.repoId, f.path))));
  return new Map([...choices].filter(([key]) => listed.has(key)));
}

export interface CommitPlan {
  repoId: string;
  name: string;
  root: string;
  /** How many checked files. */
  files: number;
  /** What git commit --only takes: every checked path, and a staged rename's old name. */
  paths: string[];
  /** Checked new files: git add first, so the commit can take them. */
  add: string[];
}

/** One commit per repository with checked files, in Repo List order. */
export function commitPlan(works: readonly RepoWork[], choices: Choices): CommitPlan[] {
  return works.flatMap((w) => {
    const checked = commitFiles(w).filter((f) => isChecked(choices, w.repoId, f));
    if (checked.length === 0) return [];
    return [{
      repoId: w.repoId, name: w.name, root: w.root, files: checked.length,
      paths: [...new Set(checked.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])))],
      add: checked.filter((f) => f.untracked).map((f) => f.path),
    }];
  });
}

/** What the Commit button will take, under it: "3 files checked in 2 repositories". */
export function checkedLabel(checked: { files: number; repos: number }): string {
  if (checked.files === 0) return localize("No files checked");
  return checked.repos === 1
    ? localize("{0} checked", plural(checked.files, "file"))
    : localize("{0} checked in {1}", plural(checked.files, "file"), plural(checked.repos, "repository", "repositories"));
}
