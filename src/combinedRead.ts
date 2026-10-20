// Combined Changes' left side: the file after the newest selected commit, with the selected
// commits' changes taken back out, newest first, by a three-way merge in memory. Reads blobs
// only; nothing is written to the repository and nothing is kept.
import { parseRangeLog } from "./combinedModel";
import { merge3 } from "./lineMerge";
import type { RunGit } from "./logQuery";

export const MERGE_LIMIT = { bytes: 1_000_000, lines: 20_000 };

export type LeftSide = { kind: "text"; text: string } | { kind: "fallback"; reason: "conflict" | "binary" | "too large" };

const NO_BLOB = /^0+$/;

/** One commit's changed files, with blob ids (merges: against their first parent; a root commit: everything added). */
export function showArgs(sha: string): string[] {
  return ["show", "--raw", "-z", "-M", "--no-abbrev", "--diff-merges=first-parent", "--format=%x1e%H %P", sha];
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
    if (!change) continue; // this commit did not touch the file
    const [after, before] = await Promise.all([blob(change.newBlob), blob(change.oldBlob)]);
    const why = unmergeable(text) ?? unmergeable(after) ?? unmergeable(before);
    if (why) return { kind: "fallback", reason: why };
    const merged = merge3(after, text, before);
    if (!merged.ok) return { kind: "fallback", reason: "conflict" };
    text = merged.text;
    current = change.oldPath ?? current;
  }
  return { kind: "text", text };
}
