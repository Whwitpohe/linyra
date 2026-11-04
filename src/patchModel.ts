// Apply Patch…: what a patch text is, and git's commands to apply it. Pure: no vscode.

/** Something git apply can read: a git diff, or a plain unified diff. */
export function looksLikePatch(text: string): boolean {
  return /^(diff --git |--- [^\n]+\r?\n\+\+\+ |Index: )/m.test(text);
}

/** git format-patch's output (an mbox, "From <sha> Mon Sep 17 …"): it can become commits as well. */
export function isMailbox(text: string): boolean {
  return /^From [0-9a-f]{40,64} /.test(text.trimStart());
}

/** A header's path: its a/ or b/ dropped, and a plain diff's tab and date after it. */
function headerPath(text: string, prefix: string): string {
  const p = text.replace(/\t.*$/, "");
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/**
 * A patch's file headers: a "--- old" line and the "+++ new" line right after it, read only
 * between hunks. A hunk's own lines can look like one (a removed "-- note" line is "--- note"),
 * so each hunk is passed over by the line counts its "@@ -a,b +c,d @@" gives.
 */
function headers(text: string): { from: string; to: string }[] {
  const lines = text.split(/\r?\n/);
  const out: { from: string; to: string }[] = [];
  let old = 0, now = 0; // the hunk's lines still to come, on each side
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (old > 0 || now > 0) {
      if (line.startsWith("-")) old--;
      else if (line.startsWith("+")) now--;
      // Kept on both sides (" ", or "" where a tool trimmed it); "\ No newline at end of file" is neither.
      else if (!line.startsWith("\\")) { old--; now--; }
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      old = hunk[1] === undefined ? 1 : Number(hunk[1]);
      now = hunk[2] === undefined ? 1 : Number(hunk[2]);
    } else if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      out.push({ from: headerPath(line.slice(4), "a/"), to: headerPath(lines[++i].slice(4), "b/") });
    }
  }
  return out;
}

/** The files a patch changes, by their new names ("diff --git a/x b/y", else "+++ b/y"). */
export function patchFiles(text: string): string[] {
  const files = new Set<string>();
  for (const m of text.matchAll(/^diff --git a\/.+? b\/(.+?)\r?$/gm)) files.add(m[1]);
  if (files.size === 0) for (const h of headers(text)) if (h.to !== "/dev/null") files.add(h.to);
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

/**
 * The files a patch expects to find already there: the old names of those it changes, renames or
 * deletes ("--- a/x"), never a file it adds (--- /dev/null). Where it fits, these exist.
 */
export function patchSources(text: string): string[] {
  const files = new Set<string>();
  for (const h of headers(text)) if (h.from !== "/dev/null") files.add(h.from);
  return [...files];
}

/**
 * Which repositories a patch fits, from the files it expects (found: how many of them each has):
 * the ones that have them all, else every one, most found first. `sure`: exactly one fits, so
 * nothing needs asking.
 */
export function patchFit<T extends { id: string }>(repos: readonly T[], expected: number, found: ReadonlyMap<string, number>): { sure: T | undefined; offer: T[]; fits: number } {
  const all = expected > 0 ? repos.filter((r) => found.get(r.id) === expected) : [];
  if (all.length === 1) return { sure: all[0], offer: all, fits: 1 };
  const pool = all.length > 1 ? all : [...repos];
  return { sure: undefined, offer: pool.sort((a, b) => (found.get(b.id) ?? 0) - (found.get(a.id) ?? 0)), fits: all.length };
}
