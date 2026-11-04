// An untracked file read for a prompt as `git add` would take it: a regular file's first bytes, a
// symbolic link's target path. Never what a link points at, never a pipe or a folder, never a
// file outside the repository. Pure: no vscode import.
import { constants, promises as fs } from "fs";
import * as path from "path";
import { newFileDiff, newLinkDiff, type FileDiff } from "./context";

/** Opens without following a link, and without waiting on a pipe, where the platform has the flags (not Windows). */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const inside = (p: string, root: string): boolean => {
  const rel = path.relative(root, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/**
 * `rel` (git's forward-slash path in `root`) as a new file's diff: its first `maxBytes`, or a
 * link's target. Undefined for anything git would not add as a file (a folder, a pipe, a socket),
 * or a path that leads out of the repository (through `..` or a linked folder). A file that cannot
 * be read is named only (binary).
 */
export async function untrackedDiff(root: string, rel: string, maxBytes: number): Promise<FileDiff | undefined> {
  const abs = path.resolve(root, ...rel.split("/"));
  if (abs === path.resolve(root) || !inside(abs, path.resolve(root))) return undefined;
  let stat;
  try {
    // The folder it is in, its links followed, is still the repository's.
    const [realRoot, realDir] = await Promise.all([fs.realpath(root), fs.realpath(path.dirname(abs))]);
    if (!inside(realDir, realRoot)) return undefined;
    stat = await fs.lstat(abs);
    if (stat.isSymbolicLink()) return newLinkDiff(rel, await fs.readlink(abs));
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  try {
    const handle = await fs.open(abs, OPEN_FLAGS);
    try {
      // Replaced by something else since the lstat: not read.
      if (!(await handle.stat()).isFile()) return undefined;
      const buf = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return newFileDiff(rel, buf.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return newFileDiff(rel, undefined);
  }
}
