import type { Branches } from "./branchModel";
import { isValidRef } from "./filterModel";
import { localize } from "./i18n";
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
  /** A tag on the checked-out commit: annotated when there is a message, lightweight when not. */
  tag: (name: string, message: string) => (message.trim() ? ["tag", "-a", "-m", message.trim(), "--", checkName(name), "HEAD"] : ["tag", "--", checkName(name), "HEAD"]),
  pushTag: (remote: string, name: string) => ["push", "--quiet", "--", checkName(remote), `refs/tags/${checkName(name)}`],
  /**
   * lease: force the push, but only while the remote branch is still at this commit (the one
   * last fetched): --force-with-lease never drops commits somebody pushed since.
   */
  push: (remote: string, branch: string, destination: string, setUpstream: boolean, lease?: string) =>
    ["push", "--quiet", ...(setUpstream ? ["--set-upstream"] : []), ...(lease ? [`--force-with-lease=refs/heads/${checkName(destination)}:${checkSha(lease)}`] : []),
      "--", checkName(remote), `refs/heads/${checkName(branch)}:refs/heads/${checkName(destination)}`],
};

function checkSha(sha: string): string {
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`not a commit id: ${sha}`);
  return sha;
}

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
  /**
   * The remote branch has commits the branch does not (an Amend, Undo Commit or rebase rewrote
   * pushed commits): only a force push replaces it. Its commit as last fetched, the lease.
   */
  lease?: string;
  /** Diverged: how many commits the remote branch has that this one does not. */
  behind?: number;
}

/** The commits a force push would drop from the remote branch: on it, not on the local one (newest first). */
export function droppedArgs(branch: string, remoteRef: string): string[] {
  return ["log", "--format=%h%x00%an%x00%ae%x00%s", "--max-count=20", `refs/heads/${checkName(branch)}..refs/remotes/${checkName(remoteRef)}`, "--"];
}

export interface DroppedCommit { sha: string; author: string; email: string; subject: string }

export function parseDropped(out: string): DroppedCommit[] {
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha = "", author = "", email = "", subject = ""] = line.split("\0");
    return { sha, author, email, subject };
  });
}

/** A repository's force push as its confirmation shows it: what it replaces, and the commits it drops there. */
export interface ForcePush {
  repo: string;
  branch: string;
  /** "origin/develop" */
  target: string;
  /** How many commits the remote branch has that the local one does not (all of them are dropped). */
  behind: number;
  /** Up to 20 of them, newest first. */
  dropped: readonly DroppedCommit[];
  /** The user's own email in that repository: commits by anyone else are called out. */
  me: string;
}

/**
 * The confirmation before a force push: never just "Force Push?". It names the commits the remote
 * branch loses, and calls out those by someone else (a colleague's pushed work, which a pull keeps).
 */
export function forcePushPrompt(rows: readonly ForcePush[]): { message: string; detail: string; button: string } {
  const others = rows.reduce((n, r) => n + r.dropped.filter((c) => c.email.toLowerCase() !== r.me.toLowerCase()).length, 0);
  const message = rows.length === 1
    ? localize("Force push {0} to {1} in {2}?", rows[0].branch, rows[0].target, rows[0].repo)
    : localize("Force push {0} repositories?", rows.length);
  const lines = rows.flatMap((r) => [
    localize("{0}: {1} drops {2} from {3}:", r.repo, r.branch, plural(r.behind), r.target),
    ...r.dropped.slice(0, 5).map((c) => `  ${c.sha}  ${c.author}  ${c.subject}`),
    ...(r.behind > 5 ? [`  ${localize("and {0} more", r.behind - 5)}`] : []),
  ]);
  const warn = others > 0
    ? localize("{0} of them are by someone else. Pull (merge or rebase) keeps them; a force push removes them from the remote.", others)
    : localize("They are all yours: commits you amended, undid or rebased.");
  return {
    message,
    detail: `${lines.join("\n")}\n\n${warn}\n${localize("--force-with-lease still refuses if the remote branch moved since the last fetch.")}`,
    button: others > 0 ? localize("Force Push Anyway") : localize("Force Push"),
  };
}

const plural = (n: number) => localize(n === 1 ? "{0} commit" : "{0} commits", n);

/** Branches never force pushed: main and master, and VS Code's git.branchProtection globs. */
export const PROTECTED_BRANCHES = ["main", "master"];

/** A glob of git.branchProtection: * within a name segment, ** across, ? one character. */
export function branchMatches(pattern: string, name: string): boolean {
  const re = pattern.split(/(\*\*|\*|\?)/).map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
  return new RegExp(`^${re}$`).test(name);
}

export function isProtected(name: string, patterns: readonly string[]): boolean {
  return [...PROTECTED_BRANCHES, ...patterns].some((p) => branchMatches(p, name));
}

/**
 * Where the checked-out branch goes: its upstream when it has one, otherwise the same name on
 * origin (or the only remote), with --set-upstream. undefined: detached, or nowhere to push.
 */
export function pushPlan(data: Branches): PushPlan | undefined {
  const branch = data.branches.find((b) => b.kind === "local" && b.current);
  if (!branch) return undefined;
  const upstreamRemote = [...data.remotes].sort((a, b) => b.length - a.length).find((r) => branch.upstream?.startsWith(`${r}/`));
  if (upstreamRemote) {
    const plan: PushPlan = { branch: branch.name, remote: upstreamRemote, destination: branch.upstream!.slice(upstreamRemote.length + 1), setUpstream: false };
    // Both ahead and behind: the remote branch has commits that are not on this one.
    const remoteSha = data.branches.find((b) => b.kind === "remote" && b.name === branch.upstream)?.sha;
    return branch.ahead > 0 && branch.behind > 0 && remoteSha ? { ...plan, lease: remoteSha, behind: branch.behind } : plan;
  }
  const remote = data.remotes.includes("origin") ? "origin" : data.remotes.length === 1 ? data.remotes[0] : undefined;
  return remote ? { branch: branch.name, remote, destination: branch.name, setUpstream: true } : undefined;
}

/** Where a repository's tags go: its branch's upstream remote, else origin, else its only remote. */
export function tagRemote(data: Branches): string | undefined {
  const branch = data.branches.find((b) => b.kind === "local" && b.current);
  const upstream = [...data.remotes].sort((a, b) => b.length - a.length).find((r) => branch?.upstream?.startsWith(`${r}/`));
  return upstream ?? (data.remotes.includes("origin") ? "origin" : data.remotes.length === 1 ? data.remotes[0] : undefined);
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
