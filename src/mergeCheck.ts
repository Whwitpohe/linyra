// Would merging two commits conflict? git merge-tree does the merge in memory; the blobs and trees
// it makes go to a scratch object directory (the repository's own is only read), so nothing is
// written to the repository. Compare's check and the branch sheet's.
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { mergeTreeArgs, parseMergeTree } from "./compareModel";
import { GitError } from "./git";
import type { RunGit } from "./logQuery";
import { isAbortError } from "./pool";

/**
 * The repository's object directory, read from the disk (no git process): .git/objects, or for a
 * worktree or submodule (.git is a "gitdir:" file) the one its common directory names.
 */
export async function objectsDir(root: string): Promise<string | undefined> {
  const dotGit = path.join(root, ".git");
  try {
    let gitDir = dotGit;
    if ((await fs.stat(dotGit)).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(await fs.readFile(dotGit, "utf8"));
      if (!m) return undefined;
      gitDir = path.resolve(root, m[1]);
    }
    const common = await fs.readFile(path.join(gitDir, "commondir"), "utf8").then((c) => path.resolve(gitDir, c.trim()), () => gitDir);
    const objects = path.join(common, "objects");
    return (await fs.stat(objects)).isDirectory() ? objects : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How many files a merge of `left` and `right` would leave conflicted: 0 merges cleanly. null when
 * it cannot be told (git before 2.38 has no merge-tree --write-tree, unrelated histories, an error).
 */
export async function conflictCount(run: RunGit, root: string, left: string, right: string, signal: AbortSignal): Promise<number | null> {
  const objects = await objectsDir(root);
  if (!objects) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "linyra-merge-"));
  try {
    let out: string;
    try {
      out = await run(root, mergeTreeArgs(left, right), signal, { env: { GIT_OBJECT_DIRECTORY: dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects } });
    } catch (e) {
      if (isAbortError(e)) throw e;
      // Exit 1: conflicts, listed on stdout.
      if (e instanceof GitError && e.exitCode === 1) out = e.stdout;
      else return null;
    }
    return parseMergeTree(out).conflicts.length;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
