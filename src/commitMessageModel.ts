// The commit message's checks, as the JetBrains commit message inspections make them, and git's
// commit.template. Pure: no vscode (the webview shows the hints as the message is typed).
import { localize } from "./i18n";

/** The subject's and the body lines' limit: what git log, mail and hosting pages show unbroken. */
export const LINE_LIMIT = 72;

/** A line exempt from the body limit: a link, or a trailer (Signed-off-by: …, Co-authored-by: …). */
const exempt = (line: string) => /\S+:\/\/\S+/.test(line) || /^[A-Za-z][\w-]*: .+/.test(line);

/**
 * What to fix before committing, at most one hint per kind: a long subject, no blank line after it,
 * a long body line. Lines git strips (# comments) are not counted. Never blocks a commit.
 */
export function messageHints(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => !l.startsWith("#"));
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  if (lines.length === 0) return [];
  const hints: string[] = [];
  const subject = lines[0].trimEnd();
  if ([...subject].length > LINE_LIMIT) hints.push(localize("The subject is {0} characters: keep it to {1}.", [...subject].length, LINE_LIMIT));
  if (lines.length > 1 && lines[1].trim() !== "") hints.push(localize("Leave the second line empty: it separates the subject from the body."));
  const long = lines.slice(1).findIndex((l) => [...l.trimEnd()].length > LINE_LIMIT && !exempt(l));
  if (long >= 0) hints.push(localize("Line {0} is {1} characters: wrap the body at {2}.", long + 2, [...lines[long + 1].trimEnd()].length, LINE_LIMIT));
  return hints;
}

/**
 * git's commit.template split as the message box uses it: its text prefills the box; its # lines
 * (guidance git strips) become the box's placeholder instead, so they are never committed.
 */
export function splitTemplate(template: string): { text: string; hint: string } {
  const lines = template.replace(/\r\n/g, "\n").split("\n");
  const text = lines.filter((l) => !l.startsWith("#")).join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  const hint = lines.filter((l) => l.startsWith("#")).map((l) => l.replace(/^#\s?/, "")).join("\n").trim();
  return { text, hint };
}
