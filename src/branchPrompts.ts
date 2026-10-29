import { localize } from "./i18n";

/**
 * What a branch action in the Repo List says before it runs, after it ran, and when git refused:
 * what will happen (not a rule), the counts that matter, the action and the repository by name.
 * Pure: no vscode import.
 */

const commits = (n: number) => localize(n === 1 ? "{0} commit" : "{0} commits", n);

/** Delete Branch's question: what goes, and what stays. */
export function deletePrompt(b: { name: string; kind: "local" | "remote"; upstream?: string; remote?: string; remoteBranch?: string }, repo: string): { message: string; detail: string; button: string } {
  if (b.kind === "remote") {
    return {
      message: localize("Delete {0} on the remote {1}?", b.name, b.remote ?? ""),
      detail: localize("The branch is deleted on the server, for everyone who uses it. Local branches stay."),
      button: localize("Delete"),
    };
  }
  return {
    message: localize("Delete branch {0} in {1}?", b.name, repo),
    detail: b.upstream
      ? localize("The local branch is deleted. Its remote branch {0} stays.", b.upstream)
      : localize("The local branch is deleted. Its commits stay on the other branches and tags that have them."),
    button: localize("Delete"),
  };
}

/** A local branch's commits that are on no other branch, remote branch or tag: what a force delete leaves behind. */
export function unmergedArgs(name: string): string[] {
  return ["rev-list", "--count", `refs/heads/${name}`, "--not", `--exclude=${name}`, "--branches", "--remotes", "--tags", "--"];
}

/** git refused to delete an unmerged branch (the normal case after a squash merge): asked again, with what is lost. */
export function deleteAnywayPrompt(name: string, repo: string, unmerged: number): { message: string; detail: string; button: string } {
  return {
    message: localize("{0} is not merged in {1}.", name, repo),
    detail: unmerged > 0
      ? localize(unmerged === 1 ? "{0} on it is on no other branch, remote branch or tag. After a squash merge that is expected: its changes are already in. git keeps it for a while (git reflog), then removes it." : "{0} on it are on no other branch, remote branch or tag. After a squash merge that is expected: their changes are already in. git keeps them for a while (git reflog), then removes them.", commits(unmerged))
      : localize("Every commit on it is also on another branch, remote branch or tag: nothing is lost."),
    button: unmerged > 0 ? localize("Delete Anyway ({0} not merged anywhere)", commits(unmerged)) : localize("Delete Anyway"),
  };
}

/** How far apart the checked-out branch and another are: `ours theirs` (left: HEAD only, right: the other only). */
export function distanceArgs(ref: string): string[] {
  return ["rev-list", "--left-right", "--count", `HEAD...${ref}`, "--"];
}

export function parseDistance(out: string): { ours: number; theirs: number } | undefined {
  const m = /^(\d+)\s+(\d+)\s*$/.exec(out.trim());
  return m ? { ours: Number(m[1]), theirs: Number(m[2]) } : undefined;
}

/**
 * Merge or Rebase a branch into the checked-out one: what moves, in counts, and that a conflict
 * stops it for the user to resolve. Nothing to take: a sentence, not a question.
 */
export function integratePrompt(method: "merge" | "rebase", current: string, other: string, repo: string, d: { ours: number; theirs: number } | undefined): { message: string; detail: string; button: string } | { nothing: string } {
  if (d && d.theirs === 0) return { nothing: localize("{0} already has every commit of {1} in {2}: nothing to {3}.", current, other, repo, localize(method)) };
  const theirs = d ? commits(d.theirs) : localize("the commits");
  if (method === "merge") {
    return {
      message: localize("Merge {0} into {1} in {2}?", other, current, repo),
      detail: localize("{0} gets {1} from {2}; if files conflict the merge stops for you to resolve.", current, theirs, other),
      button: localize("Merge"),
    };
  }
  return {
    message: localize("Rebase {1} onto {0} in {2}?", other, current, repo),
    detail: d && d.ours === 0
      ? localize("{0} has no commits of its own: it moves up to {1} ({2}).", current, other, theirs)
      : localize(d?.ours === 1 ? "Your {0} on {1} is replayed on top of {2} ({3}); if files conflict the rebase stops for you to resolve." : "Your {0} on {1} are replayed on top of {2} ({3}); if files conflict the rebase stops for you to resolve.", d ? commits(d.ours) : localize("commits"), current, other, theirs),
    button: localize("Rebase"),
  };
}

/** "Could not push feature/x in acme-web: the remote has commits you do not have: run Update Project, then push again." (`why`: whyOf) */
export function branchFailed(action: string, name: string, repo: string, why: string): string {
  switch (action) {
    case "checkout": return localize("Could not check out {0} in {1}: {2}.", name, repo, why);
    case "create": return localize("Could not create a branch from {0} in {1}: {2}.", name, repo, why);
    case "rename": return localize("Could not rename {0} in {1}: {2}.", name, repo, why);
    case "delete": return localize("Could not delete {0} in {1}: {2}.", name, repo, why);
    case "fetch": return localize("Could not fetch {0} in {1}: {2}.", name, repo, why);
    case "pull": return localize("Could not pull {0} in {1}: {2}.", name, repo, why);
    case "push": return localize("Could not push {0} in {1}: {2}.", name, repo, why);
    case "merge": case "pullMerge": return localize("Could not merge {0} in {1}: {2}.", name, repo, why);
    case "rebase": case "pullRebase": return localize("Could not rebase onto {0} in {1}: {2}.", name, repo, why);
    case "worktree": return localize("Could not create a worktree from {0} in {1}: {2}.", name, repo, why);
    default: return localize("Could not finish that for {0} in {1}: {2}.", name, repo, why);
  }
}

/** The status-bar line after a branch action that changed something. */
export function branchDone(action: string, o: { name: string; repo: string; to?: string; current?: string }): string | undefined {
  switch (action) {
    case "checkout": return localize("Linyra: checked out {0} in {1}.", o.name, o.repo);
    case "create": return localize("Linyra: created and checked out {0} in {1}.", o.to ?? o.name, o.repo);
    case "rename": return localize("Linyra: renamed {0} to {1} in {2}.", o.name, o.to ?? "", o.repo);
    case "delete": return localize("Linyra: deleted {0} in {1}.", o.name, o.repo);
    case "fetch": return localize("Linyra: fetched {0} in {1}.", o.name, o.repo);
    case "pull": return localize("Linyra: pulled {0} in {1}.", o.name, o.repo);
    case "push": return localize("Linyra: pushed {0} to {1} in {2}.", o.name, o.to ?? "", o.repo);
    case "merge": case "pullMerge": return localize("Linyra: merged {0} into {1} in {2}.", o.name, o.current ?? "", o.repo);
    case "rebase": case "pullRebase": return localize("Linyra: rebased {1} onto {0} in {2}.", o.name, o.current ?? "", o.repo);
    default: return undefined;
  }
}

/** "Could not apply stash@{0} in acme-web: …": the stash's own reasons first (it is kept on a conflict). */
export function stashFailed(action: "apply" | "pop" | "drop" | "push", ref: string, repo: string, why: string): string {
  switch (action) {
    case "apply": return localize("Could not apply {0} in {1}: {2}.", ref, repo, why);
    case "pop": return localize("Could not pop {0} in {1}: {2}.", ref, repo, why);
    case "drop": return localize("Could not drop {0} in {1}: {2}.", ref, repo, why);
    default: return localize("Could not stash the changes in {0}: {1}.", repo, why);
  }
}
