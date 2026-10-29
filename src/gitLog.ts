import { isSha, type ChangeStatus, type Commit } from "./types";
import { parseDecorations } from "./commitReferences";

// Fields separated by NUL, records terminated by RS (0x1e): no subject can be
// confused with a delimiter, so nothing needs escaping.
export const LOG_FORMAT = "--format=%H%x00%ct%x00%an%x00%ae%x00%s%x00%P%x00refs:%D%x1e";

export function parseLog(stdout: string, repoId: string): Commit[] {
  const records = stdout.split("\x1e");
  // Whatever follows the last RS is either git's trailing newline or a record
  // cut off by a killed process; neither is a commit.
  records.pop();
  const commits: Commit[] = [];
  for (const record of records) {
    const fields = record.replace(/^\n/, "").split("\0");
    if (fields.length !== 6 && !(fields.length === 7 && fields[6].startsWith("refs:"))) continue;
    const [sha, ct, author, email, subject, parents, decorations] = fields;
    const time = Number(ct);
    if (!isSha(sha) || !Number.isInteger(time)) continue;
    commits.push({ repoId, sha, time, author, email, subject, parents: parents ? parents.split(" ") : [],
      ...(decorations ? { refs: parseDecorations(decorations.slice(5)) } : {}) });
  }
  return commits;
}

/**
 * Records git actually emitted, parseable or not. Paging advances --skip by
 * this, not by parsed commits, or one malformed record would misalign every
 * later page.
 */
export function countRecords(stdout: string): number {
  return stdout.split("\x1e").length - 1;
}

/**
 * File history: RS *starts* each record, because the diff output follows the format:
 * RS <fields> NUL "\n" then, with --raw --numstat -z, each change twice —
 * ":<modes> <blobs> <STATUS>" NUL <path> NUL [<new path> NUL], then
 * "<added>\t<deleted>\t<path>" NUL (a rename: "<added>\t<deleted>\t" NUL <old> NUL <new> NUL).
 * The older --name-status shape ("<STATUS>" NUL <path> NUL …) parses too.
 */
export const HISTORY_FORMAT = "--format=%x1e%H%x00%ct%x00%an%x00%ae%x00%s%x00%P%x00refs:%D";

const HISTORY_STATUSES = new Set(["A", "M", "D", "R", "C", "T"]);

interface HistoryEntry { path: string; oldPath?: string; status: ChangeStatus }

/**
 * A record's changes (after its fields) and each path's line counts. undefined when the record
 * was cut off inside its first change (a killed process).
 */
function historyChanges(t: readonly string[], from: number): { entries: HistoryEntry[]; lines: Map<string, { added: number | null; deleted: number | null }> } | undefined {
  const entries: HistoryEntry[] = [];
  const lines = new Map<string, { added: number | null; deleted: number | null }>();
  const count = (s: string) => (s === "-" ? null : Number(s));
  for (let i = from; i < t.length;) {
    const token = t[i].replace(/^\n+/, "");
    // --raw: ":100644 100644 <blob> <blob> R086"; --name-status: "R086".
    const raw = token.startsWith(":") ? token.slice(token.lastIndexOf(" ") + 1) : /^[AMDRCT]\d*$/.test(token) ? token : undefined;
    const letter = raw?.charAt(0);
    if (letter && HISTORY_STATUSES.has(letter)) {
      const status = letter as ChangeStatus;
      const two = status === "R" || status === "C";
      const path = t[i + (two ? 2 : 1)];
      if (path === undefined || path === "") return entries.length ? { entries, lines } : undefined; // truncated
      entries.push(two ? { path, oldPath: t[i + 1], status } : { path, status });
      i += two ? 3 : 2;
      continue;
    }
    const numstat = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(token);
    if (numstat) {
      // A rename names no path inline: its old and new names follow.
      const path = numstat[3] === "" ? t[i + 2] : numstat[3];
      if (path) lines.set(path, { added: count(numstat[1]), deleted: count(numstat[2]) });
      i += numstat[3] === "" ? 3 : 1;
      continue;
    }
    i++;
  }
  return { entries, lines };
}

/**
 * One file's commits (git log --raw --numstat -z -M over every name it had), each with that
 * file's path at the time, its status letter and its lines added and deleted (null: binary).
 */
export function parseHistory(stdout: string, repoId: string, currentPath: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of stdout.split("\x1e").slice(1)) {
    const t = record.split("\0");
    if (t.length < 7) continue; // cut off by a killed process
    const [sha, ct, author, email, subject, parents] = t;
    const time = Number(ct);
    if (!isSha(sha) || !Number.isInteger(time)) continue;
    const offset = t[6]?.startsWith("refs:") ? 7 : 6;
    const changes = historyChanges(t, offset);
    if (!changes) continue;
    // A merge shows no diff: the file keeps the name the next older row will give it.
    let file: NonNullable<Commit["file"]> = { path: commits.at(-1)?.file?.oldPath ?? commits.at(-1)?.file?.path ?? currentPath };
    const first = changes.entries[0];
    if (first) {
      const lines = changes.lines.get(first.path);
      file = { ...first, ...(lines ? lines : {}) };
    }
    commits.push({ repoId, sha, time, author, email, subject, parents: parents ? parents.split(" ") : [], file,
      ...(offset === 7 ? { refs: parseDecorations(t[6].slice(5)) } : {}) });
  }
  return commits;
}
