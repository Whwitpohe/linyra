import type { Branches } from "./branchModel";
import { isValidRef } from "./filterModel";
import { localize } from "./i18n";
import { failureReason } from "./actionErrors";
import { errorLine } from "./git";
import { pullReason } from "./upstream";

/**
 * Work across every ticked repository at once, as the JetBrains IDEs do for a project with
 * several Git roots: one branch operation in all of them, one Push dialog, one Update Project.
 * Pure: the plans and argv, decided from each repository's own branch listing.
 */

export type UpdateMethod = "merge" | "rebase" | "ffOnly";
export const UPDATE_METHODS: readonly UpdateMethod[] = ["merge", "rebase", "ffOnly"];

/** linyra.updateMethod: "ask" (the default), or the method Update Project runs without asking. */
export function updateMethodSetting(value: unknown): UpdateMethod | "ask" {
  return UPDATE_METHODS.includes(value as UpdateMethod) ? value as UpdateMethod : "ask";
}

/** Update Project's question: the remembered method first. */
export function updateMethodOrder(last: unknown): UpdateMethod[] {
  const first = UPDATE_METHODS.includes(last as UpdateMethod) ? last as UpdateMethod : "merge";
  return [first, ...UPDATE_METHODS.filter((m) => m !== first)];
}

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
    : method === "ffOnly"
      ? ["-c", "merge.autoStash=false", "-c", "submodule.recurse=false", "merge", "--ff-only", "--quiet", "@{upstream}"]
      : ["-c", "rebase.autoStash=false", "-c", "submodule.recurse=false", "rebase", "--quiet", "@{upstream}"],
  /** Every local branch: its upstream, how far from it, and which is checked out (Update Project reads it once per repository). */
  branches: () => ["for-each-ref", "--format=%(refname)%00%(upstream)%00%(upstream:track,nobracket)%00%(HEAD)", "refs/heads"],
  /**
   * A branch that is not checked out and only behind its upstream, moved there without a checkout:
   * a fetch from the repository itself takes nothing but a fast-forward, and refuses a branch that
   * is checked out in any worktree.
   */
  fastForward: (b: BranchTrack) => ["fetch", "--quiet", ".", `${checkRef(b.upstream)}:${checkRef(b.ref)}`],
  /** Commits a push would send: to the upstream, or (no upstream yet) those on no remote at all. */
  outgoing: (hasUpstream: boolean) => hasUpstream
    ? ["log", "--format=%h%x00%s", "--max-count=1000", "@{upstream}..HEAD", "--"]
    : ["log", "--format=%h%x00%s", "--max-count=1000", "HEAD", "--not", "--remotes", "--"],
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
  if (/not possible to fast-forward|diverging branches/i.test(message)) return "it has diverged from its upstream: merge or rebase it";
  const pull = pullReason(message);
  // Nothing recognized: git's main line, not the whole of its stderr.
  return pull === message.trim() ? failureReason(message) ?? (errorLine(message) || pull) : pull;
}

/** git stopped half-way (a merge or rebase on conflicts): the repository is mid-operation, not as it was. */
export const stoppedOnConflicts = (message: string): boolean => /\bconflict/i.test(message);

/** A local branch as Update Project reads it (multiCommands.branches). */
export interface BranchTrack {
  ref: string;
  name: string;
  /** Its upstream's full ref name; "" when it has none. */
  upstream: string;
  ahead: number;
  behind: number;
  /** Its upstream is set but no longer there. */
  gone: boolean;
  /** Checked out here. */
  head: boolean;
}

/** A full ref name from git's own output, before it goes back into a refspec. */
function checkRef(ref: string): string {
  if (!/^refs\/[^\s:^~?*[\\]+$/.test(ref)) throw new Error(`not a ref name: ${ref}`);
  return ref;
}

export function parseBranchTracks(out: string): BranchTrack[] {
  return out.split("\n").flatMap((line) => {
    const [ref, upstream = "", track = "", head = ""] = line.replace(/\r$/, "").split("\0");
    if (!ref?.startsWith("refs/heads/")) return [];
    const count = (re: RegExp) => Number(re.exec(track)?.[1] ?? 0);
    return [{ ref, name: ref.slice("refs/heads/".length), upstream, ahead: count(/ahead (\d+)/), behind: count(/behind (\d+)/), gone: track === "gone", head: head === "*" }];
  });
}

/** The checked-out branch's distance from its upstream; null: HEAD detached, no upstream, or it is gone. */
export function headDistance(tracks: readonly BranchTrack[]): { ahead: number; behind: number } | null {
  const h = tracks.find((t) => t.head);
  return h && h.upstream && !h.gone ? { ahead: h.ahead, behind: h.behind } : null;
}

/**
 * Update Project's other branches: those behind their upstream and not checked out here. With no
 * commits of their own they are fast-forwarded; diverged ones are left as they are, and named.
 */
export function otherBranches(tracks: readonly BranchTrack[]): { forward: BranchTrack[]; diverged: BranchTrack[] } {
  const behind = tracks.filter((t) => !t.head && t.upstream !== "" && !t.gone && t.behind > 0);
  return { forward: behind.filter((t) => t.ahead === 0), diverged: behind.filter((t) => t.ahead > 0) };
}

/** Why a branch was not fast-forwarded, in words: git's refusal of a branch checked out elsewhere, or its own line. */
export function forwardReason(message: string): string {
  return /checked out at|refusing to fetch into/i.test(message) ? localize("checked out in another worktree") : errorLine(message);
}

/** What one action across repositories did, as its report groups it. */
export interface Outcome {
  done: readonly string[];
  /** Nothing to do there (already up to date, already on the branch). */
  unchanged: readonly string[];
  /** Stopped half-way on conflicts: mid-merge or mid-rebase, to resolve or abort. */
  stopped: readonly { name: string; reason: string }[];
  /** Left as they were, and why. `failed`: git refused (not just nothing to do there). */
  skipped: readonly { name: string; reason: string; failed?: boolean }[];
  /** Update Project: branches besides the checked-out ones, fast-forwarded, by repository. */
  forwarded?: readonly { name: string; branches: readonly string[] }[];
  /** Update Project: other branches left as they were (diverged, or git refused), by repository and why. */
  notForwarded?: readonly { name: string; branch: string; reason: string; failed?: boolean }[];
}

export type ReportKind = "update" | "checkout" | "create" | "merge" | "push" | "tag";

const DONE: Record<ReportKind, string> = {
  update: "Updated: {0}.", checkout: "Checked out: {0}.", create: "Created: {0}.", merge: "Merged: {0}.", push: "Pushed: {0}.", tag: "Tagged: {0}.",
};

/** Up to four names, then "and 3 more". */
function names(list: readonly string[]): string {
  return list.length > 4 ? localize("{0} and {1} more", list.slice(0, 4).join(", "), list.length - 4) : list.join(", ");
}

/**
 * The one notification after an action across repositories: who changed, who was already there,
 * who stopped half-way on conflicts, who was left as they were (grouped by why). A warning when
 * something stopped or failed. `commits`: Push… names how many commits it sent.
 */
export function multiReport(what: string, kind: ReportKind, r: Outcome, commits?: number): { level: "info" | "warning"; text: string } {
  const total = r.done.length + r.unchanged.length + r.stopped.length + r.skipped.length;
  const level = r.stopped.length > 0 || r.skipped.some((s) => s.failed) || (r.notForwarded ?? []).some((n) => n.failed) ? "warning" : "info";
  const forwarded = r.forwarded ?? [], notForwarded = r.notForwarded ?? [];
  if (r.done.length === 0 && r.stopped.length === 0 && r.skipped.length === 0 && forwarded.length === 0 && notForwarded.length === 0) {
    if (total === 0) return { level, text: localize("{0}: nothing to do.", what) };
    if (kind === "update") return { level, text: total === 1 ? localize("{0}: {1} is already up to date.", what, r.unchanged[0]) : localize("{0}: all {1} repositories already up to date.", what, total) };
    if (kind === "checkout") return { level, text: localize("{0}: every repository is already on it.", what) };
  }
  const parts: string[] = [];
  if (r.done.length > 0) {
    parts.push(kind === "push" && commits !== undefined
      ? localize("Pushed {0} to {1}.", localize(commits === 1 ? "{0} commit" : "{0} commits", commits), r.done.length === 1 ? r.done[0] : localize("{0} repositories", r.done.length))
      : localize(DONE[kind], names(r.done)));
  }
  if (r.unchanged.length > 0) parts.push(localize(kind === "update" ? "Already up to date: {0}." : kind === "checkout" ? "Already on it: {0}." : "Nothing to do: {0}.", names(r.unchanged)));
  if (r.stopped.length > 0) parts.push(localize("Stopped on conflicts, resolve or abort: {0}.", names(r.stopped.map((s) => s.name))));
  // Left as they were, one group per reason: "acme-api, acme-libs (no upstream branch)".
  const why = new Map<string, string[]>();
  for (const s of r.skipped) why.set(s.reason, [...(why.get(s.reason) ?? []), s.name]);
  if (why.size > 0) parts.push(localize("Left as they were: {0}.", [...why].map(([reason, list]) => `${names(list)} (${reason})`).join("; ")));
  // The other branches: "master in acme-web, acme-api; release-1.4 in acme-libs".
  const where = (byBranch: Map<string, string[]>) => [...byBranch].map(([branch, repos]) => localize("{0} in {1}", branch, names(repos))).join("; ");
  if (forwarded.length > 0) {
    const byBranch = new Map<string, string[]>();
    for (const f of forwarded) for (const b of f.branches) byBranch.set(b, [...(byBranch.get(b) ?? []), f.name]);
    parts.push(localize("Fast-forwarded too: {0}.", where(byBranch)));
  }
  const notWhy = new Map<string, Map<string, string[]>>();
  for (const n of notForwarded) {
    const byBranch = notWhy.get(n.reason) ?? new Map<string, string[]>();
    byBranch.set(n.branch, [...(byBranch.get(n.branch) ?? []), n.name]);
    notWhy.set(n.reason, byBranch);
  }
  if (notWhy.size > 0) parts.push(localize("Other branches left as they were: {0}.", [...notWhy].map(([reason, byBranch]) => `${where(byBranch)} (${reason})`).join("; ")));
  const head = kind === "push" && commits !== undefined && r.done.length > 0 ? "" : `${what} — `;
  return { level, text: `${head}${parts.join(" ")}` };
}
