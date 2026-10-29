// What every AI feature puts into a prompt: diffs cut per file and in total, files the settings
// exclude left out by name only, and the model's answers read back. Pure: no vscode import.

/** Characters, not tokens (about four per token): one file's diff, a new file's text, a whole prompt's diffs. */
export interface Limits { fileChars: number; newFileChars: number; totalChars: number }
export const LIMITS: Limits = { fileChars: 12_000, newFileChars: 6_000, totalChars: 60_000 };

/** One file of a patch (`git diff`, `git show`), its header lines included. */
export interface FileDiff {
  path: string;
  oldPath?: string;
  text: string;
  binary?: boolean;
}

export type LeftOutReason = "excluded" | "binary" | "budget";

/** What a prompt carries of a set of diffs: the sections it sends, and the files it leaves out (by name). */
export interface Budgeted {
  sections: string[];
  /** Diffs cut to the per-file limit. */
  cut: string[];
  left: { path: string; why: LeftOutReason }[];
  chars: number;
}

const ESCAPES: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };

/** git's C-quoted path ("caf\303\251.txt"): octal escapes are UTF-8 bytes. */
function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") { bytes.push(...new TextEncoder().encode(c)); continue; }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; continue; }
    bytes.push(ESCAPES[body[i + 1]] ?? body.charCodeAt(i + 1));
    i++;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
const stripPrefix = (s: string, prefix: string): string => (s.startsWith(prefix) ? s.slice(prefix.length) : s);

/** A patch, one section per file: `diff --git` starts each; the path comes from +++/---, a rename, or the header. */
export function splitPatch(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  const starts: number[] = [];
  const re = /^diff --git /gm;
  for (let m = re.exec(patch); m; m = re.exec(patch)) starts.push(m.index);
  starts.forEach((start, i) => {
    const text = patch.slice(start, starts[i + 1] ?? patch.length).replace(/\n+$/, "\n");
    const lines = text.split("\n");
    let path: string | undefined, oldPath: string | undefined, from: string | undefined;
    for (const line of lines.slice(1)) {
      if (line.startsWith("@@")) break;
      if (line.startsWith("+++ ")) { const p = unquote(line.slice(4)); if (p !== "/dev/null") path = stripPrefix(p, "b/"); }
      else if (line.startsWith("--- ")) { const p = unquote(line.slice(4)); if (p !== "/dev/null") from = stripPrefix(p, "a/"); }
      else if (line.startsWith("rename from ")) oldPath = unquote(line.slice(12));
      else if (line.startsWith("rename to ")) path = unquote(line.slice(10));
    }
    if (!path && from) path = from;
    if (!path) {
      // "diff --git a/x b/x": both halves name the file; a binary file has no +++ line.
      const header = lines[0].slice("diff --git ".length);
      const half = header.length > 1 ? header.slice(Math.floor(header.length / 2) + 1) : header;
      path = stripPrefix(unquote(half), "b/");
    }
    files.push({ path, ...(oldPath && oldPath !== path ? { oldPath } : {}), text, ...(/^Binary files .* differ$|^GIT binary patch$/m.test(text) ? { binary: true } : {}) });
  });
  return files;
}

/**
 * The diffs a prompt sends, in order: files the settings exclude and binary files by name only,
 * each diff cut at `fileChars`, and none once `totalChars` is spent (those by name too).
 */
export function budgetDiffs(files: readonly FileDiff[], excluded: (path: string) => boolean, limits: Limits = LIMITS): Budgeted {
  const out: Budgeted = { sections: [], cut: [], left: [], chars: 0 };
  for (const f of files) {
    if (excluded(f.path) || (f.oldPath !== undefined && excluded(f.oldPath))) { out.left.push({ path: f.path, why: "excluded" }); continue; }
    if (f.binary) { out.left.push({ path: f.path, why: "binary" }); continue; }
    const long = f.text.length > limits.fileChars;
    const text = long ? `${f.text.slice(0, limits.fileChars)}\n… (diff cut here: ${f.text.length - limits.fileChars} more characters)\n` : f.text;
    if (out.chars + text.length > limits.totalChars) { out.left.push({ path: f.path, why: "budget" }); continue; }
    if (long) out.cut.push(f.path);
    out.sections.push(text);
    out.chars += text.length;
  }
  return out;
}

/** A new file not in git yet, as a diff would show it: its first `newFileChars` characters. */
export function newFileDiff(path: string, content: string | undefined, limits: Limits = LIMITS): FileDiff {
  if (content === undefined || content.includes("\0")) return { path, text: `diff --git a/${path} b/${path}\nnew file\nBinary files /dev/null and b/${path} differ\n`, binary: true };
  const body = content.length > limits.newFileChars ? `${content.slice(0, limits.newFileChars)}\n… (cut here)` : content;
  const lines = body.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return { path, text: `diff --git a/${path} b/${path}\nnew file (not tracked yet)\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n` };
}

/** One line for the prompt naming what it leaves out, or "" when nothing is. */
export function leftOutNote(b: Pick<Budgeted, "left" | "cut">): string {
  const why = { excluded: "excluded by the user's settings", binary: "binary", budget: "over the size limit" } as const;
  const parts = (Object.keys(why) as LeftOutReason[]).flatMap((k) => {
    const paths = b.left.filter((l) => l.why === k).map((l) => l.path);
    return paths.length ? [`${why[k]}: ${paths.join(", ")}`] : [];
  });
  if (b.cut.length) parts.push(`cut short: ${b.cut.join(", ")}`);
  return parts.length ? `Files whose diff is not shown (${parts.join("; ")}).` : "";
}

/** The answer's language: the UI's, as a BCP 47 tag. */
export function languageLine(language: string): string {
  return `Write your answer in the language with BCP 47 tag "${language || "en"}".`;
}

/** A model's text without the code fence it may have wrapped it in. */
export function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(t);
  return m ? m[1] : t;
}

/** The one JSON object of an answer (fenced or with words around it), or undefined. */
export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const t = stripFences(text);
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(t.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A block of text fenced for the prompt, its fence longer than any run of backticks inside. */
export function fenced(text: string, info = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${info}\n${text.replace(/\n$/, "")}\n${fence}`;
}
