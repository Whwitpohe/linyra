// The branch sheet: what a branch pill's click shows — the branch, its upstream, where it merges
// and what to do next. Pure: no vscode (the webview draws what these return).
import { localize } from "./i18n";

export type SheetKind = "local" | "remote" | "tag";

/** One for-each-ref line for the ref (local branch, remote branch or tag). */
export function sheetRefArgs(ref: string): string[] {
  return ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(worktreepath)%00%(subject)%00%(*subject)%00%(authorname)%00%(*authorname)%00%(creatordate:unix)%00%(*authordate:unix)%00%(authordate:unix)", "--", ref];
}

export interface SheetRef {
  ref: string;
  name: string;
  kind: SheetKind;
  /** The commit (an annotated tag's, not the tag object). */
  sha: string;
  current: boolean;
  /** "origin/develop"; null when none is configured. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The upstream is configured but its branch is gone (deleted on the remote and pruned). */
  gone: boolean;
  /** The worktree that has it checked out (this repository's own folder included); "" when none. */
  worktree: string;
  subject: string;
  author: string;
  time: number;
}

const shortName = (ref: string): string => ref.replace(/^refs\/(heads|remotes|tags)\//, "");
const kindOf = (ref: string): SheetKind | undefined => (ref.startsWith("refs/heads/") ? "local" : ref.startsWith("refs/remotes/") ? "remote" : ref.startsWith("refs/tags/") ? "tag" : undefined);

/** The ref's line, or undefined when git listed nothing (the branch was deleted meanwhile). */
export function parseSheetRef(stdout: string, ref: string): SheetRef | undefined {
  const line = stdout.split("\n").map((l) => l.replace(/\r$/, "")).find((l) => l.startsWith(`${ref}\0`));
  const kind = kindOf(ref);
  if (!line || !kind) return undefined;
  const [, sha = "", peeled = "", head = "", upstream = "", track = "", worktree = "", subject = "", peeledSubject = "", author = "", peeledAuthor = "", created = "", peeledDate = "", authored = ""] = line.split("\0");
  const n = (re: RegExp) => Number(re.exec(track)?.[1] ?? 0);
  return {
    ref, name: shortName(ref), kind, sha: peeled || sha, current: head === "*",
    upstream: upstream || null, ahead: n(/ahead (\d+)/), behind: n(/behind (\d+)/), gone: /\bgone\b/.test(track),
    worktree, subject: peeledSubject || subject, author: peeledAuthor || author,
    time: Number(peeledDate || authored || created) || 0,
  };
}

/** What the sheet sends to the webview. */
export interface BranchSheetData {
  repoId: string;
  repoName: string;
  ref: string;
  name: string;
  kind: SheetKind;
  current: boolean;
  tip: { sha: string; subject: string; author: string; time: number };
  /** Local branches only. */
  upstream?: { name: string | null; ahead: number; behind: number; gone: boolean };
  /** Local branches with a merge target other than themselves. conflicts: undefined not checked, null unknown. */
  target?: { name: string; ahead: number; behind: number; conflicts?: number | null };
  /** Checked out in another worktree (its folder). */
  worktree?: string;
  /** Linyra AI is on: Explain. */
  ai: boolean;
}

/** The buttons a card or step can carry; each runs one of Linyra's existing commands. */
export type SheetAction = "fetch" | "push" | "pull" | "forcePush" | "publish" | "merge" | "rebase" | "review" | "delete" | "switch" | "openWorktree" | "explain" | "createBranch" | "pushTag";

export type Tone = "good" | "bad" | "neutral";

export interface SheetCard {
  /** "Upstream", "Merges into". */
  title: string;
  /** The ref the title names ("origin/develop"), shown in the editor font. */
  subject?: string;
  chip?: { text: string; tone: Tone };
  status: string;
  /** Why, or what it means: a muted second line. */
  hint?: string;
  buttons: { action: SheetAction; label: string; primary?: boolean }[];
}

const plural = (n: number, one: string, many: string) => localize(n === 1 ? one : many, n);

/** What the sheet calls the ref: its heading, its region and its Copy button. */
export function kindLabel(kind: SheetKind): string {
  return kind === "tag" ? localize("Tag") : kind === "remote" ? localize("Remote Branch") : localize("Branch");
}

/** The worktree folder's last name. */
export const worktreeName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

/** The upstream card (local branches): its state as of the last fetch, and what can be done. */
export function upstreamCard(d: BranchSheetData): SheetCard | undefined {
  const u = d.upstream;
  if (d.kind !== "local" || !u) return undefined;
  const title = localize("Upstream");
  const fetch = { action: "fetch" as const, label: localize("Fetch") };
  const commits = (n: number) => plural(n, "{0} commit", "{0} commits");
  if (!u.name) return { title, status: localize("Not published."), hint: localize("No remote branch tracks it yet."), buttons: [{ action: "publish", label: localize("Publish"), primary: true }] };
  if (u.gone) {
    // Usually its pull request merged and the host deleted it: clean up, rather than push it back.
    return {
      title, subject: u.name, chip: { text: localize("Gone"), tone: "bad" }, status: localize("Deleted on the remote."),
      hint: localize("Often deleted after its pull request merged; Publish pushes it again."),
      buttons: [...(d.current ? [] : [{ action: "delete" as const, label: localize("Delete Branch…") }]), { action: "publish", label: localize("Publish") }],
    };
  }
  if (u.ahead > 0 && u.behind > 0) {
    return {
      title, subject: u.name, chip: { text: localize("Diverged"), tone: "bad" },
      status: localize("{0} to push · {1} to pull.", commits(u.ahead), u.behind),
      hint: localize("Pushed commits were rewritten, or both sides have new commits."),
      buttons: [...(d.current ? [{ action: "pull" as const, label: localize("Pull"), primary: true }] : []), { action: "forcePush", label: localize("Force Push…") }, fetch],
    };
  }
  if (u.ahead > 0) return { title, subject: u.name, status: localize("{0} to push.", commits(u.ahead)), buttons: [{ action: "push", label: localize("Push"), primary: true }, fetch] };
  if (u.behind > 0) {
    return {
      title, subject: u.name, status: localize("{0} to pull.", commits(u.behind)),
      ...(d.current ? {} : { hint: localize("Check it out to pull.") }),
      buttons: [...(d.current ? [{ action: "pull" as const, label: localize("Pull"), primary: true }] : []), fetch],
    };
  }
  return { title, subject: u.name, chip: { text: localize("Up to date"), tone: "good" }, status: localize("As of the last fetch."), buttons: [fetch] };
}

/** The merge target card (local branches): its own commits, how far behind, conflicts, merged. */
export function targetCard(d: BranchSheetData): SheetCard | undefined {
  const t = d.target;
  if (d.kind !== "local" || !t) return undefined;
  const title = localize("Merges into");
  const review = { action: "review" as const, label: localize("Review") };
  const own = localize("{0} not on {1}", plural(t.ahead, "{0} commit", "{0} commits"), t.name);
  if (t.ahead === 0) {
    return {
      title, subject: t.name, chip: { text: localize("Merged"), tone: "neutral" }, status: localize("Every commit is on {0}.", t.name),
      ...(d.current ? {} : { hint: localize("Safe to delete.") }),
      buttons: d.current ? [] : [{ action: "delete", label: localize("Delete Branch…") }],
    };
  }
  if (t.behind === 0) return { title, subject: t.name, status: localize("{0}.", own), buttons: [review] };
  const check = t.conflicts === undefined ? undefined
    : t.conflicts === null ? { chip: { text: localize("Conflicts unknown"), tone: "neutral" as const }, hint: localize("Needs Git 2.38 or later to check before merging.") }
    : t.conflicts === 0 ? { chip: { text: localize("No conflicts"), tone: "good" as const }, hint: localize("Merging it in goes through cleanly.") }
    : { chip: { text: plural(t.conflicts, "{0} file conflicts", "{0} files conflict"), tone: "bad" as const }, hint: localize("Merging it in stops on them to resolve.") };
  return {
    title, subject: t.name, ...(check ?? {}),
    status: localize("{0} · {1} behind.", own, t.behind),
    buttons: [...(d.current ? [{ action: "merge" as const, label: localize("Merge"), primary: true }, { action: "rebase" as const, label: localize("Rebase") }] : []), review],
  };
}

/**
 * The next steps, only those that fit its state: switch to it (not a merged branch: it changes
 * nothing), the worktree that has it, a tag's own, and Explain where there is something to explain.
 */
export function nextSteps(d: BranchSheetData): { text: string; action: SheetAction; label: string }[] {
  const steps: { text: string; action: SheetAction; label: string }[] = [];
  if (d.kind === "tag") {
    steps.push({ text: localize("Check it out (detached HEAD)"), action: "switch", label: localize("Switch") });
    steps.push({ text: localize("Create a branch from it"), action: "createBranch", label: localize("Create Branch…") });
    steps.push({ text: localize("Push it to a remote"), action: "pushTag", label: localize("Push…") });
    return steps;
  }
  const merged = d.kind === "local" && d.target?.ahead === 0;
  if (d.worktree) steps.push({ text: localize("Checked out in worktree {0}", worktreeName(d.worktree)), action: "openWorktree", label: localize("Open Worktree") });
  else if (!d.current && !merged) steps.push({ text: d.kind === "remote" ? localize("Check it out as a local branch") : localize("Switch to it"), action: "switch", label: localize("Switch") });
  if (d.kind === "remote") {
    steps.push({ text: localize("Fetch it from its remote"), action: "fetch", label: localize("Fetch") });
    steps.push({ text: localize("Review it against the checked-out branch"), action: "review", label: localize("Review") });
  }
  if (d.ai && d.kind !== "remote") {
    if (d.current && (d.upstream?.ahead ?? 0) > 0) steps.push({ text: localize("Explain the unpushed commits"), action: "explain", label: localize("Explain") });
    else if (!d.current && !merged) steps.push({ text: localize("Explain what it changes"), action: "explain", label: localize("Explain") });
  }
  return steps;
}
