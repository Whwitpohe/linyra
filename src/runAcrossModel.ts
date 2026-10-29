// Run a Git Command Across Repositories…: the command line typed, whether it only reads, and the
// report of what each repository answered. Pure: no vscode.
import { localize } from "./i18n";

/**
 * The words of a command line as a shell would split them (spaces; '…' literally; "…" with \" and
 * \\), never run through one. A leading "git" is dropped. A string is the problem with the line.
 */
export function parseCommandLine(line: string): string[] | string {
  const words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = undefined; else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) word += line[++i];
      else word += c;
    } else if (/\s/.test(c)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else {
      word = (word ?? "") + c;
    }
  }
  if (quote) return localize("A quote is not closed.");
  if (word !== undefined) words.push(word);
  if (words[0] === "git") words.shift();
  if (words.length === 0) return localize("Type a git command, for example: status -sb");
  return words;
}

/** Commands that only read whatever their arguments; branch, tag, remote, stash, config and worktree only when they list. */
const READERS = new Set(["status", "log", "diff", "show", "describe", "rev-parse", "rev-list", "shortlog", "blame", "grep", "ls-files", "ls-remote",
  "ls-tree", "cat-file", "count-objects", "for-each-ref", "show-ref", "whatchanged", "cherry", "range-diff", "merge-base", "name-rev", "version", "help"]);
const LISTING_FLAGS = /^(-a|--all|-r|--remotes|-v|-vv|--verbose|--list|-l|--merged|--no-merged|--contains|--no-contains|--points-at|--sort=.*|--format=.*|--show-current|--column|--no-column|-n\d*)$/;

/** Whether the command cannot change a repository (then it runs without asking first). */
export function isReadOnly(args: readonly string[]): boolean {
  const [cmd, ...rest] = args;
  if (!cmd || cmd.startsWith("-")) return false;
  if (READERS.has(cmd)) return !rest.some((a) => a === "--output" || a.startsWith("--output=") || a === "--ext-diff");
  if (cmd === "branch" || cmd === "tag") return rest.every((a) => LISTING_FLAGS.test(a) || (cmd === "tag" && rest.includes("-l")) || (cmd === "branch" && rest.includes("--list")));
  if (cmd === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v") || rest[0] === "show" || rest[0] === "get-url";
  if (cmd === "stash") return rest[0] === "list" || rest[0] === "show";
  if (cmd === "config") return rest.length > 0 && rest.every((a) => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--local|--global|--system|--name-only|--null|-z)$/.test(a) || !a.startsWith("-")) && rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a));
  if (cmd === "worktree") return rest[0] === "list";
  return false;
}

/** What one repository answered. */
export interface RunResult {
  repo: string;
  /** null: it did not finish (a timeout, or git could not start). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The report: the command, the count, then each repository's output under its name (failures first). */
export function runReport(command: string, results: readonly RunResult[]): string {
  const failed = results.filter((r) => r.code !== 0);
  const head = `$ git ${command}\n${failed.length === 0
    ? localize("{0} repositories, all succeeded.", results.length)
    : localize("{0} repositories, {1} failed.", results.length, failed.length)}\n`;
  const ordered = [...failed, ...results.filter((r) => r.code === 0)];
  const section = (r: RunResult) => {
    const status = r.code === 0 ? "" : r.code === null ? ` (${localize("did not finish")})` : ` (${localize("exit {0}", r.code)})`;
    const body = [r.stdout.replace(/\s+$/, ""), r.stderr.replace(/\s+$/, "")].filter(Boolean).join("\n");
    return `── ${r.repo}${status} ──\n${body || localize("(no output)")}\n`;
  };
  return [head, ...ordered.map(section)].join("\n");
}

/** How the command is shown back: its words, quoted where needed. */
export function commandText(args: readonly string[]): string {
  return args.map((a) => (/^[\w./:=@^~+-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, "\\$1")}"`)).join(" ");
}
