// What Insights reads from a repository's git dir with no git process: Health's commit-graph and
// tracked-file count, whether HEAD has a commit yet, and whether the git dir is shared (a linked
// worktree's settings and objects are its main repository's).
import { promises as fs } from "fs";
import * as path from "path";
import { gitDirOf } from "../repoHead";
import { indexEntries } from "./parse";

const exists = (p: string) => fs.stat(p).then(() => true, () => false);

/** The git dir and the common one (a linked worktree's main repository's .git). */
async function dirs(root: string): Promise<{ dir: string; common: string } | undefined> {
  const dir = await gitDirOf(root);
  if (!dir) return undefined;
  const common = await fs.readFile(path.join(dir, "commondir"), "utf8").then((c) => path.resolve(dir, c.trim()), () => dir);
  return { dir, common };
}

/** The index's entry count from its 12-byte header; 0 with no index yet; undefined if unreadable or split. */
async function indexCount(dir: string): Promise<number | undefined> {
  let file: fs.FileHandle | undefined;
  try {
    file = await fs.open(path.join(dir, "index"), "r");
    const buf = new Uint8Array(12);
    const { bytesRead } = await file.read(buf, 0, 12, 0);
    // A split index's own entries are only those changed since its shared index.
    const split = (await fs.readdir(dir)).some((n) => n.startsWith("sharedindex."));
    return indexEntries(buf.subarray(0, bytesRead), split);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : undefined;
  } finally {
    await file?.close();
  }
}

/**
 * Health's facts from the files: a commit-graph (one file, or a split chain) in the common
 * objects dir; the tracked files; whether this is a linked worktree, whose writes land in the
 * main repository's git dir.
 */
export async function gitDirFacts(root: string): Promise<{ commitGraph: boolean | undefined; tracked: number | undefined; shared: boolean }> {
  const d = await dirs(root);
  if (!d) return { commitGraph: undefined, tracked: undefined, shared: false };
  const info = path.join(d.common, "objects", "info");
  const [single, chain, tracked] = await Promise.all([exists(path.join(info, "commit-graph")), exists(path.join(info, "commit-graphs", "commit-graph-chain")), indexCount(d.dir)]);
  return { commitGraph: single || chain, tracked, shared: path.resolve(d.dir) !== path.resolve(d.common) };
}

/**
 * Whether HEAD names a branch with no commit yet (a new repository): true, false, or undefined when
 * the files cannot say (the reftable format). Asked only after git failed: its message is translated.
 */
export async function unbornHead(root: string): Promise<boolean | undefined> {
  const d = await dirs(root);
  if (!d) return undefined;
  const head = (await fs.readFile(path.join(d.dir, "HEAD"), "utf8").catch(() => "")).trim();
  const m = /^ref:\s*(\S+)$/.exec(head);
  if (!m) return head ? false : undefined; // detached: a commit
  if (await exists(path.join(d.common, "reftable"))) return undefined;
  const ref = m[1];
  if ((await exists(path.join(d.common, ...ref.split("/")))) || (await exists(path.join(d.dir, ...ref.split("/"))))) return false;
  const packed = await fs.readFile(path.join(d.common, "packed-refs"), "utf8").catch(() => "");
  return !packed.split(/\r?\n/).some((line) => line.endsWith(` ${ref}`));
}
