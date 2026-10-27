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
 * File history: RS *starts* each record, because --name-status output follows
 * the format: RS <fields> NUL "\n" <STATUS> NUL <path> NUL [<new path> NUL].
 */
export const HISTORY_FORMAT = "--format=%x1e%H%x00%ct%x00%an%x00%ae%x00%s%x00%P%x00refs:%D";

const HISTORY_STATUSES = new Set(["A", "M", "D", "R", "C", "T"]);

/** One file's commits (git log --follow --name-status -z), each with that file's path at the time. */
export function parseHistory(stdout: string, repoId: string, currentPath: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of stdout.split("\x1e").slice(1)) {
    const t = record.split("\0");
    if (t.length < 7) continue; // cut off by a killed process
    const [sha, ct, author, email, subject, parents] = t;
    const time = Number(ct);
    if (!isSha(sha) || !Number.isInteger(time)) continue;
    const offset = t[6]?.startsWith("refs:") ? 7 : 6;
    const letter = (t[offset] ?? "").replace(/^\n+/, "").charAt(0);
    let file: NonNullable<Commit["file"]> = { path: commits.at(-1)?.file?.oldPath ?? commits.at(-1)?.file?.path ?? currentPath };
    if (HISTORY_STATUSES.has(letter)) {
      const status = letter as ChangeStatus;
      const twoPaths = status === "R" || status === "C";
      const path = t[offset + (twoPaths ? 2 : 1)];
      if (path === undefined || path === "") continue; // truncated
      file = twoPaths ? { path, oldPath: t[offset + 1], status } : { path, status };
    }
    commits.push({ repoId, sha, time, author, email, subject, parents: parents ? parents.split(" ") : [], file,
      ...(offset === 7 ? { refs: parseDecorations(t[6].slice(5)) } : {}) });
  }
  return commits;
}
