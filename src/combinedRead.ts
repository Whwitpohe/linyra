// Combined Changes' left side: the file after the newest selected commit, with the selected
// commits' changes taken back out, newest first, by a three-way merge in memory. Reads blobs
// only; nothing is written to the repository and nothing is kept.
import { combineRepo, mergeBaseArgs, parseRangeLog, rangeLogArgs, type CombinedFile } from "./combinedModel";
import { merge3 } from "./lineMerge";
import type { RunGit } from "./logQuery";
import { runPool } from "./pool";

export const MERGE_LIMIT = { bytes: 1_000_000, lines: 20_000 };

export type LeftSide = { kind: "text"; text: string } | { kind: "fallback"; reason: "conflict" | "binary" | "too large" };

const NO_BLOB = /^0+$/;

/** One commit's changed files, with blob ids (merges: against their first parent; a root commit: everything added). */
export function showArgs(sha: string): string[] {
  return ["show", "--raw", "-z", "-M", "--no-abbrev", "--diff-merges=first-parent", "--format=%x1e%H %P%x1f%s", sha];
}

/** Why a text can't go through the merge, if it can't: git's binary test, or the size limit. */
function unmergeable(text: string): "binary" | "too large" | undefined {
  if (text.slice(0, 8000).includes("\0")) return "binary";
  if (text.length > MERGE_LIMIT.bytes || Buffer.byteLength(text) > MERGE_LIMIT.bytes) return "too large";
  let lines = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) if (++lines > MERGE_LIMIT.lines) return "too large";
  return undefined;
}

export async function leftSide(run: RunGit, root: string, last: string, path: string, without: readonly string[], signal: AbortSignal): Promise<LeftSide> {
  const blob = (id: string) => (NO_BLOB.test(id) ? Promise.resolve("") : run(root, ["cat-file", "blob", id], signal));
  // A file the newest commit deleted has no right side: start from empty.
  let text = await run(root, ["show", `${last}:${path}`], signal).catch((e: unknown) => {
    if (signal.aborted) throw e;
    return "";
  });
  const right = text;
  /** Each step's file before and after its commit, newest first: checked again at the end. */
  const steps: { before: string; after: string }[] = [];
  let current = path;
  // The revision `text` stands for: renames between it and the next commit are followed back.
  let state = last;
  for (const sha of without) {
    const [commit] = parseRangeLog(await run(root, showArgs(sha), signal));
    if (!commit) continue;
    let change = commit.changes.find((c) => c.path === current);
    if (!change && state !== sha) {
      // Renamed by a commit in between (one not selected): its path after this commit.
      const between = parseRangeLog(`\x1e${sha}\0${await run(root, ["diff", "--raw", "-z", "-M", "--no-abbrev", sha, state], signal)}`)[0];
      const renamed = between?.changes.find((c) => c.path === current && c.oldPath !== undefined);
      if (renamed) {
        current = renamed.oldPath!;
        change = commit.changes.find((c) => c.path === current);
      }
    }
    state = commit.parents[0] ?? state;
    // The range log says this commit touched the file: not finding it means the path was lost.
    if (!change) return { kind: "fallback", reason: "conflict" };
    const [after, before] = await Promise.all([blob(change.newBlob), blob(change.oldBlob)]);
    const why = unmergeable(text) ?? unmergeable(after) ?? unmergeable(before);
    if (why) return { kind: "fallback", reason: why };
    const merged = merge3(after, text, before);
    if (!merged.ok) return { kind: "fallback", reason: merged.tooLarge ? "too large" : "conflict" };
    text = merged.text;
    steps.push({ before, after });
    current = change.oldPath ?? current;
  }
  // The guard: the selected changes put back onto the left side must give the right side
  // exactly. Where the line alignment made them come apart, show the plain diff instead.
  let check = text;
  for (const s of [...steps].reverse()) {
    const r = merge3(s.before, check, s.after);
    if (!r.ok) return { kind: "fallback", reason: "conflict" };
    check = r.text;
  }
  if (check !== right) return { kind: "fallback", reason: "conflict" };
  return { kind: "text", text };
}

/** One repository's Combined Changes: its files, how each diff opens, and what cancelled out. */
export interface RepoRead {
  files: (CombinedFile & { mode: "fast" | "merge" | "fallback"; reason?: "conflict" | "binary" | "too large" })[];
  noNetChange: string[];
  /** Subjects of the unselected commits in range (the ⚠ tooltip names them). */
  subjects: Record<string, string>;
}

/** The files that may conflict are merged a few at a time: each is a handful of git reads. */
const SLOW_FILES_AT_ONCE = 4;

export async function readCombined(run: RunGit, root: string, selected: readonly { sha: string; parents: readonly string[] }[], signal: AbortSignal): Promise<RepoRead> {
  const shas = selected.map((s) => s.sha);
  // The range starts below the commit every selected one descends from (none: unrelated histories).
  const base = (await run(root, mergeBaseArgs(shas), signal).catch((e: unknown) => {
    if (signal.aborted) throw e;
    return "";
  })).trim();
  const baseCommit = selected.find((s) => s.sha === base);
  const exclude = base === "" ? [] : baseCommit ? [...baseCommit.parents] : [base];
  const log = parseRangeLog(await run(root, rangeLogArgs(shas, exclude), signal));
  const chosen = new Set(shas);
  const { files, noNetChange } = combineRepo(chosen, log);
  const subjects: Record<string, string> = {};
  for (const c of log) if (!chosen.has(c.sha) && c.subject !== undefined) subjects[c.sha] = c.subject;
  const slow = files.filter((f) => !f.fast);
  const settled = await runPool(slow, SLOW_FILES_AT_ONCE, async (f, inner) => {
    const left = await leftSide(run, root, f.last, f.path, [...f.shas].reverse(), inner);
    if (left.kind === "fallback") return { mode: "fallback" as const, reason: left.reason };
    const right = await run(root, ["show", `${f.last}:${f.path}`], inner).catch((e: unknown) => {
      if (inner.aborted) throw e;
      return "";
    });
    return { mode: left.text === right ? ("none" as const) : ("merge" as const) };
  }, signal);
  const failed = settled.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
  const how = new Map(slow.map((f, i) => [f, (settled[i] as PromiseFulfilledResult<{ mode: "fallback" | "merge" | "none"; reason?: "conflict" | "binary" | "too large" }>).value]));
  const out: RepoRead["files"] = [];
  for (const f of files) {
    const h = how.get(f);
    if (!h) out.push({ ...f, mode: "fast" });
    else if (h.mode === "none") noNetChange.push(f.path);
    else out.push(h.reason ? { ...f, mode: h.mode, reason: h.reason } : { ...f, mode: h.mode });
  }
  return { files: out, noNetChange, subjects };
}
