// Smart Checkout, as the JetBrains IDEs offer it when local changes would be overwritten: stash
// them, check out, put them back. No vscode: the caller asks first and reports.
import { localize } from "./i18n";

/** The stash's message: what it is for, so it can be found in the Repo List's Stashes. */
export const smartLabel = (target: string) => `Linyra: Smart Checkout of ${target}`;

/** The question when git refused: one repository, or several (Branches Across Repositories). */
export function smartPrompt(repos: readonly string[], target: string): { message: string; detail: string; button: string } {
  return {
    message: repos.length === 1
      ? localize("Local changes in {0} would be overwritten by checking out {1}.", repos[0], target)
      : localize("Local changes in {0} repositories would be overwritten by checking out {1}: {2}.", repos.length, target, repos.join(", ")),
    detail: localize("Smart Checkout stashes them, checks out {0} and puts them back. Where they conflict with {0}, the conflicts are left to resolve and the stash is kept.", target),
    button: localize("Smart Checkout"),
  };
}

/** What became of the changes, in one sentence; undefined when they are simply back. */
export function smartReport(repo: string, target: string, r: SmartResult): string | undefined {
  if (r.reapplied) return undefined;
  if (r.conflicts?.length) return localize("Checked out {0} in {1}. Your changes conflict with it in {2} files: resolve them. They are also kept in the stash “{3}”.", target, repo, r.conflicts.length, smartLabel(target));
  return localize("Checked out {0} in {1}, but your changes could not be put back ({2}). They are kept in the stash “{3}”: apply it from the Repo List's Stashes.", target, repo, r.reason ?? "", smartLabel(target));
}

/** What git refused the checkout for (its English words: run it with LC_ALL=C). */
export type CheckoutBlock = "changes" | "untracked";

export function checkoutBlock(message: string): CheckoutBlock | undefined {
  if (/untracked working tree files would be (overwritten|removed) by checkout/i.test(message)) return "untracked";
  if (/local changes to the following files would be overwritten by checkout|commit your changes or stash them before you switch/i.test(message)) return "changes";
  return undefined;
}

export interface SmartResult {
  /** The changes are back in the working tree (and the index as it was); the stash is gone. */
  reapplied: boolean;
  /** Put back with conflicts: these files are left to resolve, and the stash is kept. */
  conflicts?: string[];
  /** Not put back at all: why, in git's words. The stash is kept. */
  reason?: string;
}

const stderrOf = (e: unknown) => {
  const s = (e as { stderr?: unknown } | undefined)?.stderr;
  return typeof s === "string" && s.trim() ? s : e instanceof Error ? e.message : String(e);
};
const firstLine = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/^(error|fatal):\s*/, "").trim()).find(Boolean) ?? text.trim();

/**
 * Stashes the local changes (untracked files too when those were in the way), runs the checkout,
 * then applies the stash back, keeping what was staged staged where it can. A failed checkout puts
 * the changes back where they were. `git` must run in the repository with LC_ALL=C.
 */
export async function smartCheckout(git: (args: string[]) => Promise<string>, block: CheckoutBlock, label: string, checkout: () => Promise<unknown>): Promise<SmartResult> {
  await git(["stash", "push", ...(block === "untracked" ? ["--include-untracked"] : []), "-m", label]);
  const sha = (await git(["rev-parse", "-q", "--verify", "refs/stash"])).trim();
  /** Our stash's place in the list now (another program may have stashed meanwhile). */
  const ref = async () => {
    const i = (await git(["stash", "list", "--format=%H"])).split(/\r?\n/).indexOf(sha);
    return i < 0 ? undefined : `stash@{${i}}`;
  };
  /** An apply that failed: the files it left in conflict, or git's reason when it applied nothing. */
  const failed = async (e: unknown): Promise<SmartResult> => {
    const conflicts = (await git(["diff", "--name-only", "-z", "--diff-filter=U", "--"])).split("\0").filter(Boolean);
    return conflicts.length > 0 ? { reapplied: false, conflicts } : { reapplied: false, reason: firstLine(stderrOf(e)) };
  };
  const putBack = async (): Promise<SmartResult> => {
    const r = await ref();
    if (!r) return { reapplied: false, reason: "the stash is no longer there" };
    try {
      await git(["stash", "apply", "--index", r]);
    } catch (e) {
      // The staged part no longer applies to the new index: everything back, unstaged.
      if (!/Conflicts in index|try without --index/i.test(stderrOf(e))) return failed(e);
      try {
        await git(["stash", "apply", r]);
      } catch (e2) {
        return failed(e2);
      }
    }
    await git(["stash", "drop", "--quiet", r]);
    return { reapplied: true };
  };
  try {
    await checkout();
  } catch (e) {
    await putBack();
    throw e;
  }
  return putBack();
}
