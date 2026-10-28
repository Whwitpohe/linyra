/** A stash entry, as `git stash list` names it. */
export interface Stash {
  /** stash@{n}: what git's own commands take. */
  ref: string;
  sha: string;
  /** Commit time, seconds. */
  time: number;
  /** git's reflog subject: "On main: message" or "WIP on main: abc1234 subject". */
  subject: string;
}

/** Fields NUL-separated, one entry per line. */
export const stashListArgs = (): string[] => ["stash", "list", "--format=%gd%x00%H%x00%ct%x00%gs"];

export function parseStashes(output: string): Stash[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const [ref, sha, ct, subject = ""] = line.split("\0");
    const time = Number(ct);
    return isStashRef(ref) && /^[0-9a-f]{40,64}$/.test(sha ?? "") && Number.isInteger(time) ? [{ ref, sha, time, subject }] : [];
  });
}

export function isStashRef(ref: unknown): ref is string {
  return typeof ref === "string" && /^stash@\{\d+\}$/.test(ref);
}

/** The label a stash row shows: its message, without git's "On <branch>:" prefix (the branch goes in the tooltip). */
export function stashLabel(s: Stash): string {
  const m = /^(?:WIP on|On) [^:]*: (.*)$/.exec(s.subject);
  return (m ? m[1] : s.subject).trim() || s.ref;
}

/** Explicit argv: a stash is only ever named by a checked stash@{n}. */
export const stashCommands = {
  push: (message: string, untracked: boolean) => ["stash", "push", ...(untracked ? ["--include-untracked"] : []), "-m", message.trim()],
  apply: (ref: string) => ["stash", "apply", "--index", check(ref)],
  pop: (ref: string) => ["stash", "pop", "--index", check(ref)],
  drop: (ref: string) => ["stash", "drop", check(ref)],
  /** The stash's own changes: its base (first parent) against the stashed work tree. */
  files: (sha: string) => ["diff", "--raw", "--numstat", "-z", "-M", `${sha}^1`, sha, "--"],
};

function check(ref: string): string {
  if (!isStashRef(ref)) throw new Error(`not a stash: ${ref}`);
  return ref;
}

/** Why an apply or pop stopped, in a few words (a localize key), or undefined for git's own line. */
export function stashStopped(stderr: string): string | undefined {
  if (/conflict/i.test(stderr)) return "the stash's changes conflict with the working tree: resolve them in Source Control (the stash is kept)";
  if (/would be overwritten|already exists, no checkout|could not restore untracked/i.test(stderr)) return "local changes are in the way: commit or stash them first";
  return undefined;
}
