import { localize } from "./i18n";
// The Commit side bar, as the Commit tool window of the JetBrains IDEs shows uncommitted work:
// Changes and Unversioned Files, each by repository and folder, every row with a checkbox, and a
// commit of the checked files only. Pure: no vscode import.
import { kindCounts, sumKinds, type KindCounts } from "./changeKinds";
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
  /** The tooltip is Markdown with theme icons ($(git-branch)): lists and repositories. */
  markdown?: true;
  /** A list's icon: a codicon in a theme color. */
  icon?: { id: string; color: string };
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

/** Added (git add, never committed): Remove from VCS takes it out again, the file kept. */
export const isAdded = (f: CommitFile): boolean => !f.untracked && f.staged && f.status === "A";

/** How the side bar groups files, as the JetBrains Commit window's Group By: by repository, by directory, both or neither. */
export interface CommitGrouping {
  repo: boolean;
  dir: boolean;
}

/** A row's menus know what is under it: ".added" when some file there can leave version control. */
const addedUnder = (rows: readonly CommitRow[]) => (rows.some((r) => r.contextValue === "commitFile.added" || r.contextValue.endsWith(".added")) ? ".added" : "");

function describeFiles(nodes: readonly TreeNode[], files: ReadonlyMap<string, CommitFile>, parent: string, base: string, w: RepoWork, choices: Choices, flat: boolean): CommitRow[] {
  return nodes.map((n): CommitRow => {
    if (n.kind === "folder") {
      const path = parent ? `${parent}/${n.name}` : n.name;
      const children = describeFiles(n.children, files, path, base, w, choices, flat);
      const c = counts(children);
      return { id: `${base}:d:${path}`, kind: "folder", label: n.name, description: c.check === "mixed" ? `${c.checked}/${c.files}` : String(c.files), tooltip: path,
        repoId: w.repoId, path, children, contextValue: `commitFolder${base.startsWith("unversioned:") ? ".unversioned" : ""}${addedUnder(children)}`, ...c };
    }
    const f = files.get(n.file.path)!;
    const state = f.untracked ? localize("new") : localize(statusName[f.status ?? "M"] ?? "modified");
    const on = isChecked(choices, w.repoId, f);
    // A flat list names each file's folder beside it, as Source Control's list view does.
    const dir = flat && f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    return {
      id: `${base}:f:${f.path}`, kind: "file", label: n.name, description: [dir, f.oldPath ? `← ${f.oldPath}` : ""].filter(Boolean).join(" · "),
      check: on ? "on" : "off", files: 1, checked: on ? 1 : 0,
      tooltip: `${f.oldPath ? `${f.oldPath} → ` : ""}${f.path} · ${state}${f.staged && f.changed ? ` · ${localize("partly staged")}` : ""}`,
      repoId: w.repoId, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.untracked ? "A" : f.status, untracked: f.untracked,
      // Open File and File History want the half that has the working tree's file.
      group: f.changed ? "changes" : "staged",
      contextValue: `commitFile.${f.untracked ? "untracked" : f.status === "D" ? "deleted" : isAdded(f) ? "added" : "changed"}`,
    };
  });
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Text in a Markdown tooltip: Markdown and theme-icon syntax ($(…)) escaped, so a name shows as written. */
export const mdText = (text: string): string => text.replace(/[\\`*_{}[\]()#+\-!~|<>$]/g, "\\$&");

/** "develop ↑1 ↓2": the repository row's branch, as Source Control's status bar names it; "" when unknown. */
export function branchText(w: RepoWork): string {
  const b = w.branch;
  if (!b) return "";
  if (b.name === null) return localize("HEAD detached at {0}", w.head?.slice(0, 7) ?? "HEAD");
  return [b.name, b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : ""].filter(Boolean).join(" ");
}

/** "$(git-branch) develop · $(cloud) origin/develop · ↑1": a tooltip's branch line (Markdown); "" when unknown. */
export function branchLine(w: RepoWork): string {
  const b = w.branch;
  if (!b) return "";
  if (b.name === null) return `$(git-commit) ${mdText(localize("HEAD detached at {0}", w.head?.slice(0, 7) ?? "HEAD"))}`;
  const parts = [`$(git-branch) ${mdText(b.name)}`];
  if (b.upstream === null) parts.push(`$(cloud-upload) ${mdText(localize("unpublished"))}`);
  else {
    parts.push(`$(cloud) ${mdText(b.upstream)}`);
    const state = b.gone ? localize("gone") : b.uncounted ? localize("differs") : [b.ahead ? `↑${b.ahead}` : "", b.behind ? `↓${b.behind}` : ""].filter(Boolean).join(" ");
    if (state) parts.push(mdText(state));
  }
  return parts.join(" · ");
}

/** "$(edit) 3  $(diff-added) 143": files by kind, a tooltip's counts line (Markdown). */
export function countsLine(c: KindCounts): string {
  const parts: [string, number][] = [["edit", c.modified], ["diff-added", c.added], ["diff-removed", c.deleted], ["diff-renamed", c.renamed]];
  return parts.filter(([, n]) => n > 0).map(([icon, n]) => `$(${icon}) ${n}`).join("&nbsp;&nbsp;");
}

/** Files by kind, as the Log's Uncommitted rows count them. */
const kindsOf = (files: readonly CommitFile[]): KindCounts =>
  kindCounts(files.map((f): FileChange => ({ path: f.path, status: f.status ?? "M", added: null, deleted: null, ...(f.untracked ? { untracked: true } : {}) })));

/** A Markdown tooltip's lines, empty ones left out: a paragraph each. */
const paragraphs = (lines: readonly string[]): string => lines.filter(Boolean).join("\n\n");

/** A list's tooltip names each repository's branch, up to this many. */
const LIST_BRANCHES = 10;

/**
 * Everything the Commit side bar shows: Changes, then Unversioned Files, each by repository (in
 * Repo List order) and folder, or as `group` says. A list, repository or folder is checked when
 * all its files are. Without repository rows, each repository's top rows name it.
 */
export function describeCommit(works: readonly RepoWork[], choices: Choices, accents: ReadonlyMap<string, number> = new Map(), behind: (repoId: string) => boolean = () => false,
  group: CommitGrouping = { repo: true, dir: true }): {
  roots: CommitRow[]; message: string | undefined; checked: { files: number; repos: number }; total: number;
} {
  const lists: CommitRow[] = [];
  let total = 0;
  for (const [list, label, untracked] of [["changes", localize("Changes"), false], ["unversioned", localize("Unversioned Files"), true]] as const) {
    const repos: CommitRow[] = [];
    const kinds: KindCounts[] = [];
    const branches: string[] = [];
    for (const w of works) {
      const files = commitFiles(w).filter((f) => f.untracked === untracked);
      if (files.length === 0) continue;
      total += files.length;
      const k = kindsOf(files);
      kinds.push(k);
      const branch = branchLine(w);
      if (branch) branches.push(`**${mdText(w.name)}** · ${branch}`);
      const byPath = new Map(files.map((f) => [f.path, f]));
      const base = `${list}:${w.repoId}`;
      const nodes: TreeNode[] = group.dir
        ? fileTree(files.map((f): FileChange => ({ path: f.path, added: null, deleted: null })))
        : files.map((f) => ({ kind: "file", name: basename(f.path), file: { path: f.path, added: null, deleted: null } }));
      const children = describeFiles(nodes, byPath, "", base, w, choices, !group.dir);
      if (!group.repo) {
        repos.push(...children.map((r) => ({ ...r, description: [w.name, r.description].filter(Boolean).join(" · "), tooltip: `${w.name}: ${r.tooltip}` })));
        continue;
      }
      const c = counts(children);
      repos.push({
        // "develop ↑1 · 3 files": the branch beside the count, as the Log's Uncommitted row shows it.
        id: base, kind: "repo", label: w.name, description: [branchText(w), partly(c, plural(c.files, "file"))].filter(Boolean).join(" · "),
        repoId: w.repoId, accent: accents.get(w.repoId) ?? 0, children, ...c, markdown: true,
        tooltip: paragraphs([mdText(w.canStage ? w.root : localize("{0}: Discard Changes needs VS Code's Git to have this repository open.", w.name)), branch, countsLine(k)]),
        // .conflicted: a merge or rebase stopped here (Resolve Conflicts…, and AI's).
        contextValue: `commitRepo${behind(w.repoId) ? ".behind" : ""}${untracked ? ".unversioned" : ""}${addedUnder(children)}${(w.conflicts ?? 0) > 0 ? ".conflicted" : ""}`,
      });
    }
    if (repos.length === 0) continue;
    const c = counts(repos);
    const more = branches.length - LIST_BRANCHES;
    lists.push({ id: list, kind: "list", label, description: partly(c, plural(c.files, "file")), children: repos, ...c, markdown: true,
      tooltip: paragraphs([
        // New files enter version control either way, as in the JetBrains IDEs: checked, with the commit; or now, by Add to VCS.
        mdText(untracked ? localize("New files: check them to add them with the commit, or Add to VCS (Ctrl+Alt+A) to add them now.") : label),
        ...branches.slice(0, LIST_BRANCHES), more > 0 ? mdText(localize("and {0} more", more)) : "", countsLine(sumKinds(kinds)),
      ]),
      // Source Control's own colors: changed files, new files.
      icon: untracked ? { id: "diff-added", color: "gitDecoration.untrackedResourceForeground" } : { id: "diff-modified", color: "gitDecoration.modifiedResourceForeground" },
      contextValue: `commitList${untracked ? ".unversioned" : ""}${addedUnder(repos)}` });
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

/**
 * Commit… on a repository (the Uncommitted side, the Changes view): that repository's files checked
 * as the side bar checks them by default (tracked ones; its new files too when it has nothing else),
 * every other repository's unchecked.
 */
export function checkOnly(works: readonly RepoWork[], repoId: string): Map<string, boolean> {
  const next = new Map<string, boolean>();
  for (const w of works) {
    const files = commitFiles(w);
    const onlyNew = w.repoId === repoId && files.every((f) => f.untracked);
    for (const f of files) {
      const want = w.repoId === repoId && (onlyNew || !f.untracked);
      if (want !== !f.untracked) next.set(fileKey(w.repoId, f.path), want);
    }
  }
  return next;
}

/**
 * The Commit side bar's report when some repositories committed and others did not: which did,
 * which did not and why, and that Commit tries the rest again (the message is kept).
 */
export function commitPartly(done: readonly string[], failed: readonly { name: string; why: string }[]): string {
  const not = failed.map((f) => `${f.name} (${f.why})`).join("; ");
  return done.length === 0
    ? localize("Linyra could not commit: {0}. The message is kept: fix that, then Commit again.", not)
    : localize("Committed in {0}. Not committed in {1}. The message is kept: Commit again takes the files still checked there.", done.join(", "), not);
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

/**
 * Add to .gitignore: one line for a new file or folder of the repository, anchored at its root
 * ("/build/out.log", "/build/"), git's wildcards and a file's trailing spaces escaped.
 */
export function ignoreLine(path: string, folder: boolean): string {
  const escaped = path.replace(/[\\*?[]/g, "\\$&");
  return folder ? `/${escaped}/` : `/${escaped.replace(/ +$/, (spaces) => spaces.replace(/ /g, "\\ "))}`;
}

/** The .gitignore with the lines it does not have yet appended, in its own line ending; undefined when it has them all. */
export function withIgnored(existing: string, lines: readonly string[]): string | undefined {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const have = new Set(existing.split(/\r?\n/));
  const add = [...new Set(lines)].filter((line) => !have.has(line));
  if (add.length === 0) return undefined;
  return `${existing}${existing === "" || existing.endsWith("\n") ? "" : eol}${add.join(eol)}${eol}`;
}
