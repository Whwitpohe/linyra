// Combined Changes: from one repository's range log, which files the selected commits changed,
// each once, with its net status and whether its diff can take the fast path. Pure: no vscode.
import type { ChangeStatus } from "./types";

export interface RawChange {
  status: ChangeStatus;
  path: string;
  /** Renames and copies: the path before. */
  oldPath?: string;
  oldBlob: string;
  newBlob: string;
}

/** One commit of the range, as `git log --raw` prints it. Newest first, in topological order. */
export interface RangeCommit {
  sha: string;
  parents: string[];
  changes: RawChange[];
}

export interface CombinedFile {
  path: string;
  /** Renamed within the range: its path before. */
  oldPath?: string;
  status: ChangeStatus;
  /** The selected commits that touched it, oldest first. */
  shas: string[];
  last: string;
  /** The first parent of shas[0]; null for a root commit. */
  beforeRef: string | null;
  /** Its path in beforeRef. */
  beforePath: string;
  /** Unselected commits in range that touched it before `last`, oldest first. */
  included: string[];
  /** Nothing unselected touched it, and every selected commit is an ancestor of `last`: the diff is beforeRef ↔ last. */
  fast: boolean;
}

const RANGE_FORMAT = "--format=%x1e%H %P";

/** The commit every selected commit descends from: the range starts there. */
export function mergeBaseArgs(selected: readonly string[]): string[] {
  return ["merge-base", "--octopus", ...selected];
}

/** Every commit reachable from the selected ones and not from `exclude`, with each one's files (merges: against their first parent). */
export function rangeLogArgs(selected: readonly string[], exclude: readonly string[]): string[] {
  const args = ["log", "--topo-order", "--raw", "-z", "-M", "--no-abbrev", "--diff-merges=first-parent", RANGE_FORMAT, ...selected];
  return exclude.length > 0 ? [...args, "--not", ...exclude] : args;
}

const STATUSES = new Set<string>(["A", "M", "D", "R", "C", "T"]);

export function parseRangeLog(stdout: string): RangeCommit[] {
  const commits: RangeCommit[] = [];
  for (const chunk of stdout.split("\x1e")) {
    const tokens = chunk.split("\0");
    const [sha, ...parents] = tokens[0].trim().split(" ").filter((s) => s !== "");
    if (!sha) continue;
    const changes: RawChange[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i].replace(/^\n+/, "");
      if (!t.startsWith(":")) continue;
      // ":<old mode> <new mode> <old blob> <new blob> <STATUS[score]>"
      const [, , oldBlob, newBlob, code] = t.split(" ");
      const status = code?.charAt(0) ?? "";
      const twoPaths = status === "R" || status === "C";
      const first = tokens[i + 1];
      const second = twoPaths ? tokens[i + 2] : undefined;
      i += twoPaths ? 2 : 1;
      if (!STATUSES.has(status) || first === undefined || (twoPaths && second === undefined)) continue;
      changes.push(twoPaths
        ? { status: status as ChangeStatus, path: second!, oldPath: first, oldBlob, newBlob }
        : { status: status as ChangeStatus, path: first, oldBlob, newBlob });
    }
    commits.push({ sha, parents, changes });
  }
  return commits;
}

interface Acc {
  path: string;
  beforePath: string;
  beforeRef: string | null;
  first: RawChange;
  last: RawChange;
  shas: string[];
  renamed: boolean;
  /** Unselected commits since the last selected one; they count once another selected commit follows. */
  pending: string[];
  included: string[];
}

function netStatus(a: Acc): ChangeStatus | null {
  const first = a.first.status;
  const last = a.last.status;
  if (first === "A" && last === "D") return null;
  if (first === "A") return "A";
  if (last === "D") return "D";
  if (first === "D") return "M";
  return a.renamed ? "R" : "M";
}

/** The commits in `log` that `sha` descends from, itself included. */
function ancestors(sha: string, log: readonly RangeCommit[]): Set<string> {
  const bySha = new Map(log.map((c) => [c.sha, c]));
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length > 0) {
    const s = stack.pop()!;
    if (seen.has(s)) continue;
    seen.add(s);
    for (const p of bySha.get(s)?.parents ?? []) if (bySha.has(p)) stack.push(p);
  }
  return seen;
}

export function combineRepo(selected: ReadonlySet<string>, log: readonly RangeCommit[]): { files: CombinedFile[]; noNetChange: string[] } {
  const byPath = new Map<string, Acc>();
  const all: Acc[] = [];
  for (const c of [...log].reverse()) {
    const mine = selected.has(c.sha);
    for (const change of c.changes) {
      const was = change.oldPath ?? change.path;
      let acc = byPath.get(was);
      if (!acc) {
        if (!mine) continue; // not (yet) a file of the selection
        acc = { path: change.path, beforePath: was, beforeRef: c.parents[0] ?? null, first: change, last: change, shas: [], renamed: false, pending: [], included: [] };
        all.push(acc);
      }
      if (change.oldPath !== undefined && change.oldPath !== change.path) {
        byPath.delete(change.oldPath);
        acc.renamed = true;
      }
      acc.path = change.path;
      byPath.set(change.path, acc);
      if (mine) {
        acc.shas.push(c.sha);
        acc.last = change;
        acc.included.push(...acc.pending);
        acc.pending = [];
      } else {
        acc.pending.push(c.sha);
      }
    }
  }
  const files: CombinedFile[] = [];
  const noNetChange: string[] = [];
  for (const a of all) {
    const status = netStatus(a);
    const last = a.shas[a.shas.length - 1];
    const before = ancestors(last, log);
    // Only commits `last` descends from reach its version of the file.
    const included = a.included.filter((s) => before.has(s));
    const fast = included.length === 0 && a.shas.every((s) => before.has(s));
    if (status === null || (fast && a.first.oldBlob === a.last.newBlob && a.beforePath === a.path)) {
      noNetChange.push(a.path);
      continue;
    }
    const f: CombinedFile = { path: a.path, status, shas: a.shas, last, beforeRef: a.beforeRef, beforePath: a.beforePath, included, fast };
    files.push(a.renamed && a.beforePath !== a.path ? { ...f, oldPath: a.beforePath } : f);
  }
  return { files, noNetChange };
}
