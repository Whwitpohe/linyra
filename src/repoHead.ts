// A repository's branch and what it is in the middle of, read from the files git keeps them in.
// No git process, no vscode: HEAD, and MERGE_HEAD, rebase-merge/, CHERRY_PICK_HEAD… in its git dir.
import { promises as fs } from "fs";
import * as path from "path";
import { operationOf, parseHead, rebasedBranch, type RepoMark } from "./repoMarkModel";
import type { Worktree } from "./worktreeModel";

/** A repository's git dir: .git, or where a .git file points (a linked worktree, a submodule). */
export async function gitDirOf(root: string): Promise<string | undefined> {
  const dotGit = path.join(root, ".git");
  const st = await fs.stat(dotGit).catch(() => undefined);
  if (!st) return undefined;
  if (st.isDirectory()) return dotGit;
  const text = await fs.readFile(dotGit, "utf8").catch(() => "");
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  return m ? path.resolve(root, m[1]) : undefined;
}

const samePath = (a: string, b: string) => {
  const norm = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
};
const exists = (p: string) => fs.stat(p).then(() => true, () => false);

/**
 * The repository's worktrees, from its common git dir's worktrees/ folder (no git process): the
 * main working tree and each linked one, with its branch. Empty when there is no linked worktree.
 */
export async function readWorktrees(root: string): Promise<Worktree[]> {
  const dir = await gitDirOf(root);
  if (!dir) return [];
  // A linked worktree's git dir names the common one in its commondir file.
  const commonRel = await fs.readFile(path.join(dir, "commondir"), "utf8").catch(() => undefined);
  const common = commonRel ? path.resolve(dir, commonRel.trim()) : dir;
  const names = await fs.readdir(path.join(common, "worktrees")).catch(() => [] as string[]);
  if (names.length === 0) return [];
  const headOf = async (gitDir: string) => parseHead((await fs.readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => "")) ?? "") ?? { branch: null };
  const list: Worktree[] = [];
  // The main working tree holds the common dir as its .git (none for a bare repository).
  if (path.basename(common) === ".git") {
    const main = path.dirname(common);
    list.push({ path: main, ...(await headOf(common)), main: true, current: samePath(main, root) });
  }
  for (const name of names.sort()) {
    const admin = path.join(common, "worktrees", name);
    const gitdir = await fs.readFile(path.join(admin, "gitdir"), "utf8").catch(() => undefined);
    if (!gitdir) continue;
    const folder = path.dirname(path.resolve(admin, gitdir.trim()));
    const [head, locked, present] = await Promise.all([headOf(admin), exists(path.join(admin, "locked")), exists(folder)]);
    list.push({ path: folder, ...head, main: false, current: samePath(folder, root), ...(locked ? { locked: true } : {}), ...(present ? {} : { missing: true }) });
  }
  return list;
}

/** The branch (during a rebase, the one being rebased) and the operation that stopped, if any. */
export async function readHead(root: string): Promise<Omit<RepoMark, "work"> | undefined> {
  const dir = await gitDirOf(root);
  if (!dir) return undefined;
  const [head, names] = await Promise.all([fs.readFile(path.join(dir, "HEAD"), "utf8").catch(() => undefined), fs.readdir(dir).catch(() => [] as string[])]);
  const parsed = head === undefined ? undefined : parseHead(head);
  if (!parsed) return undefined;
  const has = new Set(names);
  let operation = operationOf((n) => has.has(n));
  if (!operation) return parsed;
  // rebase-apply/applying: git am's own session, not a rebase (git rebase --continue refuses it).
  if (operation === "rebase" && has.has("rebase-apply") && await fs.stat(path.join(dir, "rebase-apply", "applying")).then(() => true, () => false)) operation = "am";
  if (operation !== "rebase") return { ...parsed, operation };
  // A rebase detaches HEAD: the branch it is rebasing is in its head-name file.
  const headName = await fs.readFile(path.join(dir, has.has("rebase-merge") ? "rebase-merge" : "rebase-apply", "head-name"), "utf8").catch(() => undefined);
  const branch = rebasedBranch(headName);
  return { ...parsed, ...(typeof branch === "string" ? { branch } : {}), operation };
}
