// Uncommitted changes, read from git: what is staged and what is not (new untracked files
// included), each with its +/- counts; and git given those files as its pathspec. Pure: no vscode import.
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type { RunOptions } from "./git";
import type { ChangeStatus, FileChange } from "./types";

/** git's empty tree: what a repository with no commit yet is compared with. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Which files differ, ignored ones never; `pathspecs` is the Path filter, after --.
 * --branch adds the last commit's id, so one call per repository says everything.
 */
export function statusArgs(pathspecs: readonly string[]): string[] {
  const args = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"];
  return pathspecs.length > 0 ? [...args, "--", ...pathspecs] : args;
}

/** The last commit's id from `git status --branch` ("# branch.oid <sha>"); null before the first commit. */
export function headOf(stdout: string): string | null {
  const m = /(?:^|\0)# branch\.oid ([0-9a-f]{40,64})(?:\0|$)/.exec(stdout);
  return m ? m[1] : null;
}

/** The checked-out branch and its upstream, as `git status --porcelain=v2 --branch` reports them. */
export interface BranchStatus {
  /** The branch's short name; null when HEAD is detached. Set before the first commit too. */
  name: string | null;
  /** The upstream's short name ("origin/develop"); null when none is configured. */
  upstream: string | null;
  /** Commits not pushed and commits to pull; 0 without an upstream, a gone one, or uncounted. */
  ahead: number;
  behind: number;
  /** An upstream is configured but its branch does not exist (deleted on the remote and pruned, or never pushed). */
  gone?: true;
  /** The branch differs from its upstream, but git did not count by how much (status.aheadBehind=false). */
  uncounted?: true;
}

/**
 * The branch header of `git status --porcelain=v2 --branch` (with or without -z): its
 * `# branch.head`, `# branch.upstream` and `# branch.ab` lines. Undefined when the output has no
 * branch header (status ran without --branch). The header comes before every file, so a file
 * whose name looks like a header line is never read as one.
 */
export function branchOf(stdout: string): BranchStatus | undefined {
  let head: string | undefined;
  let upstream: string | null = null;
  let ab: string | undefined;
  for (const line of stdout.split(/\0|\n/)) {
    if (!line.startsWith("# ")) break;
    const [key, ...rest] = line.slice(2).split(" ");
    const value = rest.join(" ");
    if (key === "branch.head") head = value;
    else if (key === "branch.upstream") upstream = value;
    else if (key === "branch.ab") ab = value;
  }
  if (head === undefined) return undefined;
  const out: BranchStatus = { name: head === "(detached)" ? null : head, upstream, ahead: 0, behind: 0 };
  if (upstream === null) return out;
  // No ab line: the upstream's branch does not exist. "+? -?": it differs, uncounted.
  if (ab === undefined) return { ...out, gone: true };
  const m = /^\+(\d+) -(\d+)$/.exec(ab);
  return m ? { ...out, ahead: Number(m[1]), behind: Number(m[2]) } : { ...out, uncounted: true };
}

/** `git diff --numstat -z` output: path → counts (null for binary). Renames by the new name. */
export function parseNumstat(stdout: string): Map<string, { added: number | null; deleted: number | null }> {
  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i]);
    if (!m) continue;
    const n = (v: string) => (v === "-" ? null : Number(v));
    let path = m[3];
    if (path === "") {
      i += 2; // rename: "a\td\t", then the old and the new name
      path = tokens[i];
    }
    counts.set(path, { added: n(m[1]), deleted: n(m[2]) });
  }
  return counts;
}

/** One side of an uncommitted file: what is staged (index) or what is not yet (working tree). */
export interface WorkEntry {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  untracked?: boolean;
  conflicted?: boolean;
  /** Staged side only: the index's blob id (porcelain v2's hI). */
  blob?: string;
}

/** An index blob id, unless it is the null id (a deletion staged). */
const blobOf = (oid: string | undefined): { blob?: string } => (oid && /^[0-9a-f]{40,64}$/.test(oid) && !/^0+$/.test(oid) ? { blob: oid } : {});

const letter = (c: string): ChangeStatus => (c === "A" ? "A" : c === "D" ? "D" : c === "T" ? "T" : "M");

/**
 * A submodule checked out at the commit the index has, its own files changed (the sub field
 * "S.MU", "S..U"): the working tree has nothing of it for this repository to commit.
 */
const onlyItsFiles = (sub: string | undefined): boolean => sub?.[0] === "S" && sub[1] !== "C";

/**
 * `git status --porcelain=v2 -z` as Source Control shows it: the index half (Staged) and the
 * working-tree half (Changes). A file staged and changed again is in both.
 */
export function splitStatus(stdout: string): { staged: WorkEntry[]; changes: WorkEntry[] } {
  const staged: WorkEntry[] = [];
  const changes: WorkEntry[] = [];
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "" || t.startsWith("# ")) continue;
    const parts = t.split(" ");
    const kind = t[0];
    if (kind === "?") {
      // "inner/": a repository of its own inside this one (git lists none of its files). Not a
      // file to commit: git add would record it as a bare gitlink, with no .gitmodules.
      if (!t.endsWith("/")) changes.push({ path: t.slice(2), status: "A", untracked: true });
    } else if (kind === "1") {
      const [x, y] = parts[1];
      const path = parts.slice(8).join(" ");
      if (x !== ".") staged.push({ path, status: letter(x), ...blobOf(parts[7]) });
      if (y !== "." && !onlyItsFiles(parts[2])) changes.push({ path, status: letter(y) });
    } else if (kind === "2") {
      const [x, y] = parts[1];
      const path = parts.slice(9).join(" ");
      const oldPath = tokens[++i]; // the original name is the next NUL field
      if (x !== ".") staged.push({ path, oldPath, status: x === "C" ? "C" : "R", ...blobOf(parts[7]) });
      // Renamed in the working tree only (mv, then git add -N): still a rename, from its old name,
      // which git lists nowhere else.
      if (y !== "." && !onlyItsFiles(parts[2])) changes.push({ path, ...(x === "." && (y === "R" || y === "C") ? { oldPath, status: y } : { status: letter(y) }) });
    } else if (kind === "u") {
      changes.push({ path: parts.slice(10).join(" "), status: "M", conflicted: true });
    }
  }
  return { staged, changes };
}

/** +/- of what is staged: the index against the last commit (or the empty tree). */
export function stagedNumstatArgs(head: string | null, pathspecs: readonly string[]): string[] {
  return ["diff", "--cached", head ?? EMPTY_TREE, "--numstat", "-z", "-M", "--", ...pathspecs];
}

/** +/- of what is not staged: the working tree against the index. */
export function unstagedNumstatArgs(pathspecs: readonly string[]): string[] {
  return ["diff", "--numstat", "-z", "--", ...pathspecs];
}

/** Writes take the index lock and never open an editor. */
const WRITE_ENV = { GIT_OPTIONAL_LOCKS: "1", GIT_EDITOR: "true" };

/**
 * git with `paths` as its pathspec, given through a file: no command line grows with the number
 * of files. Each path is literal: a file named "v[0-9].txt" or ":top" is that file, never a
 * pattern that takes others along. (`:(literal)` on each, not GIT_LITERAL_PATHSPECS: that would
 * reach the hooks git runs as well.)
 */
export async function gitWithPaths(run: (cwd: string, args: string[], signal?: AbortSignal, opts?: RunOptions) => Promise<string>, root: string, paths: readonly string[], args: string[], opts: RunOptions = {}): Promise<void> {
  const list = path.join(os.tmpdir(), `linyra-paths-${randomBytes(8).toString("hex")}`);
  try {
    await fs.writeFile(list, paths.map((p) => `:(literal)${p}`).join("\0"));
    await run(root, [...args, `--pathspec-from-file=${list}`, "--pathspec-file-nul"], undefined, { ...opts, env: { ...WRITE_ENV, ...opts.env } });
  } finally {
    await fs.rm(list, { force: true });
  }
}

/** One side's file list, with its counts. Untracked files count 0/0 (new, not binary). */
export function workFiles(entries: readonly WorkEntry[], counts: ReadonlyMap<string, { added: number | null; deleted: number | null }>): FileChange[] {
  return entries.map((e) => {
    const c = counts.get(e.path) ?? { added: 0, deleted: 0 };
    return { path: e.path, ...(e.oldPath ? { oldPath: e.oldPath } : {}), added: c.added, deleted: c.deleted, status: e.status, ...(e.untracked ? { untracked: true } : {}), ...(e.blob ? { blob: e.blob } : {}) };
  });
}
