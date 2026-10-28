import type { Branches } from "./branchModel";
import { isValidRef } from "./filterModel";
import { pullReason } from "./upstream";

/**
 * Work across every ticked repository at once, as the JetBrains IDEs do for a project with
 * several Git roots: one branch operation in all of them, one Push dialog, one Update Project.
 * Pure: the plans and argv, decided from each repository's own branch listing.
 */

export type UpdateMethod = "merge" | "rebase";

/** A branch name across repositories: local in some, remote-tracking in others. */
export interface SharedBranch {
  name: string;
  /** Repositories where it exists (locally or on one of their remotes). */
  repos: number;
}

/** Every branch name the repositories know, local or remote (without the remote's name), most shared first. */
export function sharedBranches(all: readonly Branches[]): SharedBranch[] {
  const count = new Map<string, number>();
  for (const data of all) {
    const names = new Set<string>();
    for (const b of data.branches) {
      if (b.kind === "local") names.add(b.name);
      else if (b.kind === "remote" && b.remoteBranch && b.remoteBranch !== "HEAD") names.add(b.remoteBranch);
    }
    for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  }
  return [...count].map(([name, repos]) => ({ name, repos })).sort((a, b) => b.repos - a.repos || a.name.localeCompare(b.name));
}

/** What checking out `name` means in one repository. */
export type CheckoutStep = "current" | "local" | "track" | "missing";

export function checkoutStep(data: Branches, name: string): CheckoutStep {
  if (data.current === name) return "current";
  if (data.branches.some((b) => b.kind === "local" && b.name === name)) return "local";
  // git switch guesses a tracking branch only when exactly one remote has the name.
  const remotes = data.branches.filter((b) => b.kind === "remote" && b.remoteBranch === name);
  return remotes.length === 1 ? "track" : "missing";
}

/** Explicit argv; names are checked against git's ref rules, so none can read as an option. */
export const multiCommands = {
  checkout: (name: string) => ["switch", "--no-guess", checkName(name)],
  track: (name: string, remote: string) => ["switch", "--track", "-c", checkName(name), `${remote}/${checkName(name)}`],
  create: (name: string) => ["switch", "-c", checkName(name)],
  merge: (ref: string) => ["-c", "merge.autoStash=false", "-c", "submodule.recurse=false", "merge", "--no-edit", "--quiet", "--", checkName(ref)],
  /**
   * Update Project. No autostash on purpose: it would put local edits back with conflict markers
   * and still exit 0. A repository whose local changes are in the way is skipped and named.
   */
  update: (method: UpdateMethod) => method === "merge"
    ? ["-c", "merge.autoStash=false", "-c", "submodule.recurse=false", "merge", "--no-edit", "--quiet", "@{upstream}"]
    : ["-c", "rebase.autoStash=false", "-c", "submodule.recurse=false", "rebase", "--quiet", "@{upstream}"],
  /** Commits a push would send: to the upstream, or (no upstream yet) those on no remote at all. */
  outgoing: (hasUpstream: boolean) => hasUpstream
    ? ["log", "--format=%h%x00%s", "--max-count=50", "@{upstream}..HEAD", "--"]
    : ["log", "--format=%h%x00%s", "--max-count=50", "HEAD", "--not", "--remotes", "--"],
  push: (remote: string, branch: string, destination: string, setUpstream: boolean) =>
    ["push", "--quiet", ...(setUpstream ? ["--set-upstream"] : []), "--", checkName(remote), `refs/heads/${checkName(branch)}:refs/heads/${checkName(destination)}`],
};

function checkName(name: string): string {
  if (!isValidRef(name)) throw new Error(`not a valid name: ${name}`);
  return name;
}

/** One repository's row in the Push dialog. */
export interface PushPlan {
  branch: string;
  remote: string;
  destination: string;
  setUpstream: boolean;
}

/**
 * Where the checked-out branch goes: its upstream when it has one, otherwise the same name on
 * origin (or the only remote), with --set-upstream. undefined: detached, or nowhere to push.
 */
export function pushPlan(data: Branches): PushPlan | undefined {
  const branch = data.branches.find((b) => b.kind === "local" && b.current);
  if (!branch) return undefined;
  const upstreamRemote = [...data.remotes].sort((a, b) => b.length - a.length).find((r) => branch.upstream?.startsWith(`${r}/`));
  if (upstreamRemote) return { branch: branch.name, remote: upstreamRemote, destination: branch.upstream!.slice(upstreamRemote.length + 1), setUpstream: false };
  const remote = data.remotes.includes("origin") ? "origin" : data.remotes.length === 1 ? data.remotes[0] : undefined;
  return remote ? { branch: branch.name, remote, destination: branch.name, setUpstream: true } : undefined;
}

/** `git log --format=%h%x00%s` → short hash and subject per commit. */
export function parseOutgoing(output: string): { sha: string; subject: string }[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha, subject = ""] = line.split("\0");
    return { sha, subject };
  });
}

/** Why a repository was left as it was, in a few words (a localize key or git's own line). */
export function updateReason(message: string): string {
  if (/conflict/i.test(message)) return "conflicts: resolve them in Source Control, or abort";
  if (/unstaged changes|uncommitted changes|cannot rebase/i.test(message)) return "local changes: the rebase needs a clean working tree";
  if (/no upstream|no tracking information/i.test(message)) return "no upstream branch";
  return pullReason(message);
}
