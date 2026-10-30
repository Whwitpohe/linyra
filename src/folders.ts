// Whether two paths name the same folder. Git writes a worktree's path as its real path; VS Code
// and the workspace may reach the same folder by another name. No vscode: tested by folders.test.ts.
import { promises as fs } from "fs";
import * as path from "path";

/** The same folder as spelled: resolved (slashes, a trailing one), without case on Windows and macOS. */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

/**
 * The same folder, however it is reached: also by another name for it (a symlink such as macOS'
 * /var, Windows' short 8.3 names, a subst drive). One realpath each, and only when the spellings
 * differ; a path that cannot be resolved (gone) is compared as written.
 */
export async function sameFolder(a: string, b: string): Promise<boolean> {
  if (samePath(a, b)) return true;
  const real = (p: string) => fs.realpath(p).catch(() => p);
  const [x, y] = await Promise.all([real(a), real(b)]);
  return samePath(x, y);
}
