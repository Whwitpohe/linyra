import type { RevisionRef } from "./revisionUri";
import type { ChangeStatus, Commit, FileChange } from "./types";

export function showArgs(sha: string): string[] {
  // One spawn for the whole detail: the full message (ended by RS), then --raw
  // records (each file's change status), then --numstat (its +/− counts).
  // -z: paths unquoted and NUL-terminated; -M: renames even if
  // diff.renames=false; merges diff against their first parent, matching the
  // diff editor's "before".
  return ["show", "--raw", "--numstat", "-z", "-M", "--diff-merges=first-parent", "--format=%B%x1e", sha];
}

const STATUSES = new Set<string>(["A", "M", "D", "R", "C", "T"]);

/** --raw -z records: ":<modes> <shas> <STATUS[score]>\0<path>\0", renames/copies with two paths. Keyed by the new path. */
function parseRaw(tokens: readonly string[]): Map<string, ChangeStatus> {
  const status = new Map<string, ChangeStatus>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].replace(/^\n+/, "");
    if (!t.startsWith(":")) continue;
    const letter = t.split(" ").pop()?.charAt(0) ?? "";
    const twoPaths = letter === "R" || letter === "C";
    const path = tokens[i + (twoPaths ? 2 : 1)];
    i += twoPaths ? 2 : 1;
    if (path !== undefined && STATUSES.has(letter)) status.set(path, letter as ChangeStatus);
  }
  return status;
}

export function parseShow(stdout: string): { message: string; files: FileChange[] } {
  // The message ends at the last RS before git's first NUL: a message never holds a NUL, but it
  // may hold an RS, and a path after it may too.
  const nul = stdout.indexOf("\0");
  const end = stdout.lastIndexOf("\x1e", nul < 0 ? Infinity : nul);
  const body = end < 0 ? stdout : stdout.slice(end + 1);
  const status = parseRaw(body.split("\0"));
  const files = parseNumstat(body).map((f) => {
    const s = status.get(f.path);
    return s ? { ...f, status: s } : f;
  });
  return { message: end < 0 ? "" : stdout.slice(0, end).replace(/\n+$/, ""), files };
}

const STAT = /^\n*(-|\d+)\t(-|\d+)\t([\s\S]*)$/;

export function parseNumstat(stdout: string): FileChange[] {
  const tokens = stdout.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = STAT.exec(tokens[i]);
    if (!m) continue;
    const added = m[1] === "-" ? null : Number(m[1]);
    const deleted = m[2] === "-" ? null : Number(m[2]);
    if (m[3] !== "") {
      files.push({ path: m[3], added, deleted });
      continue;
    }
    // Rename: "<a>\t<d>\t\0<old>\0<new>\0"
    const oldPath = tokens[i + 1];
    const path = tokens[i + 2];
    i += 2;
    if (!oldPath || !path) break;
    files.push({ path, oldPath, added, deleted });
  }
  return files;
}

export function diffSides(
  root: string,
  commit: Pick<Commit, "sha" | "parents">,
  file: Pick<FileChange, "path" | "oldPath"> & { status?: string },
): { before: RevisionRef; after: RevisionRef } {
  // An added file has no before, a deleted one no after: empty sides, without asking git.
  return {
    before: { root, ref: file.status === "A" ? null : commit.parents[0] ?? null, path: file.oldPath ?? file.path },
    after: { root, ref: file.status === "D" ? null : commit.sha, path: file.path },
  };
}
