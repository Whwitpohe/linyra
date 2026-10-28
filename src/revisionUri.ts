import * as nodePath from "path";
import { isSha } from "./types";

// Linyra's own scheme: the git extension's `git:` URIs are internal to
// vscode.git and have changed between releases.
export const SCHEME = "linyra";

/** The index (staging area): `git show :<path>` is the staged version of a file. */
export const INDEX = ":";

export interface RevisionRef {
  root: string;
  /** A commit id; INDEX for the staged version; null renders as empty (a root commit's "before" side). */
  ref: string | null;
  /** Repository-relative, forward slashes, as git prints it. */
  path: string;
  /** The index's blob id (ref INDEX): a new staged version is a new URI, never a stale document. */
  blob?: string;
  /** Combined Changes: these commits' changes taken back out of <ref>:<path>, newest first. */
  without?: string[];
}

/** Combined Changes' selection limit: a URI naming more commits is not one Linyra made. */
const MAX_WITHOUT = 100;

export function encodeRevision(r: RevisionRef): { path: string; query: string } {
  const q: { root: string; ref: string | null; blob?: string; without?: string[] } = { root: r.root, ref: r.ref };
  if (r.blob) q.blob = r.blob;
  if (r.without) q.without = r.without;
  return { path: `/${r.path}`, query: JSON.stringify(q) };
}

export function decodeRevision(path: string, query: string): RevisionRef {
  let q: { root?: unknown; ref?: unknown; blob?: unknown; without?: unknown };
  try {
    q = JSON.parse(query) as { root?: unknown; ref?: unknown; blob?: unknown; without?: unknown };
  } catch {
    throw new Error("not a linyra revision URI");
  }
  if (typeof q.root !== "string" || !(q.ref === null || q.ref === INDEX || isSha(q.ref))) throw new Error("not a linyra revision URI");
  if (q.blob !== undefined && !isSha(q.blob)) throw new Error("not a linyra revision URI");
  if (q.without !== undefined && !(Array.isArray(q.without) && q.without.length <= MAX_WITHOUT && q.without.every(isSha))) throw new Error("not a linyra revision URI");
  const r: RevisionRef = { root: q.root, ref: q.ref, path: path.replace(/^\//, "") };
  if (typeof q.blob === "string") r.blob = q.blob;
  if (Array.isArray(q.without)) r.without = q.without as string[];
  return r;
}

/**
 * The working-tree file a revision shows ("Open File" on a Linyra diff), or undefined
 * when the repository is not one of the workspace's or the path would leave it.
 */
export function workingFile(r: RevisionRef, repoRoots: readonly string[]): string | undefined {
  if (!repoRoots.includes(r.root) || r.path === "") return undefined;
  const file = nodePath.resolve(r.root, ...r.path.split("/"));
  const rel = nodePath.relative(r.root, file);
  const escapes = rel === ".." || rel.startsWith(`..${nodePath.sep}`);
  return rel !== "" && !escapes && !nodePath.isAbsolute(rel) ? file : undefined;
}
