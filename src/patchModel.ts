// Apply Patch…: what a patch text is, and git's commands to apply it. Pure: no vscode.

/** Something git apply can read: a git diff, or a plain unified diff. */
export function looksLikePatch(text: string): boolean {
  return /^(diff --git |--- [^\n]+\r?\n\+\+\+ |Index: )/m.test(text);
}

/** git format-patch's output (an mbox, "From <sha> Mon Sep 17 …"): it can become commits as well. */
export function isMailbox(text: string): boolean {
  return /^From [0-9a-f]{40,64} /.test(text.trimStart());
}

/** The files a patch changes, by their new names ("diff --git a/x b/y", else "+++ b/y"). */
export function patchFiles(text: string): string[] {
  const files = new Set<string>();
  for (const m of text.matchAll(/^diff --git a\/.+? b\/(.+?)\r?$/gm)) files.add(m[1]);
  if (files.size === 0) for (const m of text.matchAll(/^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?\r?$/gm)) if (m[1] !== "/dev/null") files.add(m[1]);
  return [...files];
}

/** How many commits an mbox holds. */
export function mailboxCommits(text: string): number {
  return (text.match(/^From [0-9a-f]{40,64} /gm) ?? []).length;
}

/**
 * git apply reading the patch from stdin, onto the working tree. threeWay: where its context no
 * longer matches, merge with the blobs it names and leave conflict markers (git stages the rest).
 */
export function applyArgs(opts: { check?: boolean; threeWay?: boolean } = {}): string[] {
  return ["apply", ...(opts.check ? ["--check"] : []), ...(opts.threeWay ? ["--3way"] : []), "--whitespace=nowarn", "-"];
}

/** git am: an mbox as commits, three-way where it can; stopped, it is aborted (nothing half applied). */
export function amArgs(): string[] {
  return ["am", "--3way", "--quiet"];
}
