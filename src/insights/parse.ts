// Insights' git output parsers. Pure: no vscode, no DOM, no node. Each takes one process's stdout.

/** A commit as Visual History draws it: who, when, and how many lines (added + deleted). */
export interface HistoryCommit {
  sha: string;
  /** Committer date, unix seconds: the Log's order and the date --since reads. */
  time: number;
  author: string;
  email: string;
  subject: string;
  added: number;
  deleted: number;
  files: number;
}

/** RS starts each record, so the numstat lines that follow a commit stay in its record. */
export const HISTORY_FORMAT = "--format=%x1e%H%x1f%ct%x1f%aN%x1f%aE%x1f%s";

/**
 * `git log --numstat` with HISTORY_FORMAT: each commit, its lines summed over its files ("-" is a
 * binary file: one file, no lines). --numstat, not --shortstat, whose words git translates.
 */
export function parseHistory(stdout: string): HistoryCommit[] {
  const commits: HistoryCommit[] = [];
  for (const record of stdout.split("\x1e")) {
    const newline = record.indexOf("\n");
    const head = (newline < 0 ? record : record.slice(0, newline)).split("\x1f");
    if (head.length < 5 || !/^[0-9a-f]{40,64}$/.test(head[0])) continue;
    let added = 0, deleted = 0, files = 0;
    if (newline >= 0) {
      for (const line of record.slice(newline + 1).split("\n")) {
        const m = /^(-|\d+)\t(-|\d+)\t/.exec(line);
        if (!m) continue;
        files++;
        if (m[1] !== "-") added += Number(m[1]);
        if (m[2] !== "-") deleted += Number(m[2]);
      }
    }
    commits.push({ sha: head[0], time: Number(head[1]) || 0, author: head[2], email: head[3], subject: head.slice(4).join("\x1f"), added, deleted, files });
  }
  return commits;
}

/** A tracked file at HEAD and its size in bytes. */
export interface TreeFile { path: string; size: number }

/**
 * `git ls-tree -r -l -z`: "<mode> <type> <object> <size>\t<path>" NUL. Blobs only: a submodule
 * (type commit) has no size here, and is its own repository in the workspace anyway.
 */
export function parseTree(stdout: string): TreeFile[] {
  const files: TreeFile[] = [];
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).trim().split(/\s+/);
    if (meta[1] !== "blob") continue;
    const size = Number(meta[3]);
    const path = record.slice(tab + 1);
    if (path && Number.isFinite(size)) files.push({ path, size });
  }
  return files;
}

/** `git log --name-only -z --format=`: how many commits touched each path (a commit lists a path once). */
export function parseTouches(stdout: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of stdout.split("\0")) {
    const path = token.replace(/^\n+/, "");
    if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return counts;
}

/** `git count-objects -v`. Sizes in KiB, as git prints them. */
export interface ObjectCounts {
  loose: number;
  looseKiB: number;
  inPack: number;
  packs: number;
  packKiB: number;
  prunePackable: number;
  garbage: number;
}

export function parseCountObjects(stdout: string): ObjectCounts {
  const v = new Map<string, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^([a-z-]+):\s*(\d+)/.exec(line.trim());
    if (m) v.set(m[1], Number(m[2]));
  }
  const n = (key: string) => v.get(key) ?? 0;
  return { loose: n("count"), looseKiB: n("size"), inPack: n("in-pack"), packs: n("packs"), packKiB: n("size-pack"), prunePackable: n("prune-packable"), garbage: n("garbage") };
}

/** The keys Health reads, as one `git config --get-regexp` (git prints them lowercased). */
export const HEALTH_CONFIG_REGEXP = "^(core\\.(untrackedcache|fsmonitor)|feature\\.manyfiles|maintenance\\.(repo|auto|strategy))$";

/**
 * `git config --get-regexp`: "key value" per line, every scope (system, global, local). A key with
 * no value at all ("[core] fsmonitor") is a boolean true; "key " with an empty value is not.
 * git exits 1 when nothing matched: the caller passes "" then.
 */
export function parseConfig(stdout: string): Map<string, (string | null)[]> {
  const values = new Map<string, (string | null)[]>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const space = line.indexOf(" ");
    const key = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    const value = space < 0 ? null : line.slice(space + 1);
    const list = values.get(key);
    if (list) list.push(value);
    else values.set(key, [value]);
  }
  return values;
}

/**
 * The tracked files in the index, from its 12-byte header ("DIRC", version, entry count): no git
 * process. undefined for anything that is not an index (a split index's own count is partial,
 * so it is undefined too, as is a missing file).
 */
export function indexEntries(header: Uint8Array, splitIndex = false): number | undefined {
  if (splitIndex || header.length < 12) return undefined;
  if (header[0] !== 0x44 || header[1] !== 0x49 || header[2] !== 0x52 || header[3] !== 0x43) return undefined;
  const be = (i: number) => ((header[i] << 24) | (header[i + 1] << 16) | (header[i + 2] << 8) | header[i + 3]) >>> 0;
  const version = be(4);
  if (version < 2 || version > 4) return undefined;
  return be(8);
}
