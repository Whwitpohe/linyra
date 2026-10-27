import { localize } from "./i18n";
// Blame for a file at one commit: `git blame --incremental`, read into line → commit.

export interface BlameInfo {
  hash: string;
  authorName: string;
  authorEmail: string;
  /** Seconds since the epoch. */
  authorTime: number;
  subject: string;
}

export interface Blame {
  /** 1-based final line ranges, in git's order. */
  ranges: { start: number; count: number; info: BlameInfo }[];
}

/** The commit is a SHA (validated by the caller); `--` keeps the path from reading as an option. */
export function blameArgs(sha: string, path: string): string[] {
  return ["-c", "i18n.logOutputEncoding=UTF-8", "blame", "--root", "--incremental", sha, "--", path];
}

export function parseBlame(out: string): Blame {
  const commits = new Map<string, BlameInfo>();
  const ranges: Blame["ranges"] = [];
  let cur: BlameInfo | undefined;
  for (const line of out.split("\n")) {
    // A SHA-1 or SHA-256 commit id.
    const head = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) \d+ (\d+) (\d+)$/.exec(line);
    if (head) {
      cur = commits.get(head[1]);
      if (!cur) {
        cur = { hash: head[1], authorName: "", authorEmail: "", authorTime: 0, subject: "" };
        commits.set(head[1], cur);
      }
      ranges.push({ start: Number(head[2]), count: Number(head[3]), info: cur });
      continue;
    }
    if (!cur) continue;
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? "" : line.slice(sp + 1);
    if (key === "author") cur.authorName = value;
    else if (key === "author-mail") cur.authorEmail = value.replace(/^<|>$/g, "");
    else if (key === "author-time") cur.authorTime = Number(value);
    else if (key === "summary") cur.subject = value;
  }
  return { ranges };
}

/** The commit that last changed this 1-based line, if any. */
export function blameAt(b: Blame, line: number): BlameInfo | undefined {
  return b.ranges.find((r) => line >= r.start && line < r.start + r.count)?.info;
}

const UNITS: [number, string][] = [[365 * 86400, "year"], [30 * 86400, "month"], [7 * 86400, "week"], [86400, "day"], [3600, "hour"], [60, "minute"]];

export function agoText(sec: number, nowSec: number): string {
  const d = Math.max(0, nowSec - sec);
  for (const [size, unit] of UNITS) {
    const n = Math.floor(d / size);
    if (n >= 1) return localize("{0} {1} ago", n, localize(n === 1 ? unit : `${unit}s`));
  }
  return localize("just now");
}

/** VS Code's `git.blame.editorDecoration.template` variables; an unknown one stays as written. */
export function formatBlame(template: string, info: BlameInfo, nowSec: number): string {
  const subject = info.subject.length > 50 ? `${info.subject.slice(0, 49)}…` : info.subject;
  const vars: Record<string, string> = {
    hash: info.hash,
    hashShort: info.hash.slice(0, 7),
    subject,
    authorName: info.authorName,
    authorEmail: info.authorEmail,
    authorDate: new Date(info.authorTime * 1000).toLocaleString(),
    authorDateAgo: agoText(info.authorTime, nowSec),
  };
  return template.replace(/\$\{(.+?)\}/g, (all, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : all));
}
