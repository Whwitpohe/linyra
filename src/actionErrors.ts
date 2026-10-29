import { errorLine } from "./git";
import { localize } from "./i18n";

/**
 * Why a git write failed, in a few words and with what to do next, from git's own words (run
 * with LC_ALL=C, so English whatever the system's language). undefined: git's line is the best
 * there is. Pure: no vscode import.
 */
export function failureReason(message: string): string | undefined {
  if (/not fully merged/i.test(message)) return localize("it has commits that are not merged anywhere else");
  if (/\bconflict/i.test(message)) return localize("files conflict: resolve them in Source Control, or abort");
  if (/stale info/i.test(message)) return localize("the remote branch moved since the last fetch: fetch, then try again");
  if (/\[rejected\]|non-fast-forward|fetch first|updates were rejected/i.test(message)) return localize("the remote has commits you do not have: run Update Project, then push again");
  if (/untracked working tree files would be (overwritten|removed)/i.test(message)) return localize("new files are in the way: move or delete them first");
  if (/would be overwritten|commit your changes or stash them|you have unstaged changes|uncommitted changes|your index contains/i.test(message)) return localize("local changes to the same files: commit or stash them first");
  if (/no upstream|no tracking information|has no upstream/i.test(message)) return localize("it has no upstream branch: push it once to set one");
  if (/authentication failed|permission denied|could not read username|terminal prompts disabled|access denied|returned error: 403/i.test(message)) return localize("the remote refused the sign-in: sign in to it, then try again");
  if (/could not resolve host|unable to access|connection (timed out|refused)|network is unreachable|could not read from remote repository/i.test(message)) return localize("the remote could not be reached: check the network and the remote's address");
  if (/not possible to fast-forward|diverging branches|have diverged/i.test(message)) return localize("it has diverged from its upstream: merge or rebase it (Update Project)");
  if (/already exists/i.test(message)) return localize("that name is already taken");
  return undefined;
}

/** failureReason, or git's own line when none fits: always something to say. */
export function reasonOf(message: string): string {
  return (failureReason(message) ?? (errorLine(message) || message.trim())).replace(/[.\s]+$/, "");
}

/**
 * git's own words from a failed run: its stderr (VS Code's Git keeps it there; Linyra's runner puts
 * its main line in the message), then what it printed on stdout (a merge's CONFLICT lines).
 */
export function gitText(e: unknown): string {
  const x = e as { stderr?: unknown; stdout?: unknown } | undefined;
  const main = typeof x?.stderr === "string" && x.stderr.trim() ? x.stderr : e instanceof Error ? e.message : String(e);
  return typeof x?.stdout === "string" && x.stdout.trim() ? `${main}\n${x.stdout}` : main;
}

/**
 * Why an action failed, for its error message: git's refusal in a few words with what to do
 * (reasonOf), or Linyra's own sentence as it is (an Error Linyra threw already says it plainly).
 */
export function whyOf(e: unknown): string {
  const fromGit = !!e && typeof e === "object" && ["stderr", "stdout", "exitCode", "gitErrorCode"].some((k) => k in e);
  return fromGit ? reasonOf(gitText(e)) : (e instanceof Error ? e.message : String(e)).replace(/[.\s]+$/, "");
}
