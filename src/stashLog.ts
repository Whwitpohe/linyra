// Whether a repository's stashes changed, from the file git keeps them in: no git process, no vscode.
import { promises as fs } from "fs";
import * as path from "path";
import { gitDirOf } from "./repoHead";

/**
 * refs/stash's reflog, which every stash push, pop and drop rewrites: its size, time and file, in
 * the common git dir (a linked worktree shares its stashes). "" when there are none. Two equal
 * stamps: the same stashes at the same stash@{n}.
 */
export async function stashLogStamp(root: string): Promise<string> {
  const dir = await gitDirOf(root).catch(() => undefined);
  if (!dir) return "";
  const common = await fs.readFile(path.join(dir, "commondir"), "utf8").then((rel) => path.resolve(dir, rel.trim()), () => dir);
  const st = await fs.stat(path.join(common, "logs", "refs", "stash")).catch(() => undefined);
  return st ? `${st.size}:${st.mtimeMs}:${st.ino}` : "";
}
