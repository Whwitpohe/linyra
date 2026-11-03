// Model output is untrusted: the model reads commit messages and diffs other people wrote, and
// they can steer what it writes. What its text may not do where Linyra shows it: a link in a
// notification is live (command: links run commands), and VS Code's Markdown preview loads remote
// images and stylesheets (a URL can carry a diff away). Pure: no vscode import.

/** Text for a notification, where [label](target) is a live link: the same words, never a link. */
export function notificationText(text: string): string {
  // A notification link is always written "](": with a space there, none is left.
  return text.replace(/\]\(/g, "] (");
}

/** Columns of a line's leading whitespace, a tab to the next multiple of 4 (as CommonMark counts). */
function indentOf(line: string): number {
  let col = 0;
  for (const c of line) {
    if (c === " ") col++;
    else if (c === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** A fence that opens a code block wherever it stands (top level or in a list item): at most 3 spaces in, a plain info string. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*[\w.+#-]*[ \t]*$/;
/** Elements whose text the browser reads as CSS or script, or reads in another way. */
const DENIED = new Set(["style", "script", "svg", "math"]);

/** Whether the `<` that starts `rest` (a letter, `/`, `!` or `?` after it) may be read as HTML in running text. */
function mayBeHtml(rest: string): boolean {
  const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
  // A comment, a declaration, a processing instruction.
  if (!name) return true;
  const after = rest.slice(name[0].length);
  // A bare tag (<div>, </p>, <br/>) loads nothing, unless its element reads its text as CSS or script.
  if (/^[ \t]*\/?>/.test(after)) return DENIED.has(name[1].toLowerCase());
  // Attributes, perhaps on the next line, after the blockquote marks the preview strips there.
  // Anything else (Map<K, V>, Array<string | number>) is no tag to the preview.
  return /^\s+[\s>]*[a-zA-Z_:/>]/.test(after);
}

/**
 * Text outside code blocks with raw HTML and images neutralized: every `![` is written `!\[`
 * (the image's Markdown shows as text, its URL is not loaded), and a `<` that may start HTML is
 * written `&lt;`: a line's first one before a letter, `/`, `!` or `?` (an HTML block), and in
 * running text one that starts a comment, a tag with attributes, or a style or script tag.
 */
function neutralize(text: string): string {
  let out = "";
  let lineStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      lineStart = true;
    } else if (c === "!" && text[i + 1] === "[") {
      out += "!\\[";
      i++;
      lineStart = false;
      continue;
    } else if (c === "<" && /[A-Za-z!?/]/.test(text[i + 1] ?? "")) {
      out += lineStart || mayBeHtml(text.slice(i, i + 200)) ? "&lt;" : c;
      lineStart = false;
      continue;
    } else if (!/[ \t>*+\-.)0-9]/.test(c)) {
      // Only indentation and container marks ("> ", "- ", "1. ") keep a line at its start.
      lineStart = false;
    }
    out += c;
  }
  return out;
}

/**
 * Markdown from a model as the preview may render it: code blocks as they are, everything else
 * neutralized. A block is kept as code only where the preview surely reads one: opened by a fence
 * at most 3 spaces in, its lines no less indented, closed by a fence at most 3 spaces in. Once
 * that is not sure (a fenced list item ends, a math block, front matter), nothing after it is.
 */
export function safeMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  // Text outside code is neutralized in one piece: a tag can run over several lines.
  const flush = () => {
    if (prose.length) out.push(neutralize(prose.join("\n")));
    prose = [];
  };
  // Front matter (a first line of dashes) ends where a plugin says: no code is kept in a document that starts with it.
  let sure = !/^-{3}/.test(lines[0] ?? "");
  let fence: { indent: number; close: RegExp } | undefined;
  for (const line of lines) {
    if (fence) {
      const indent = indentOf(line);
      const closes = fence.close.test(line.trimStart());
      if (line.trim() === "" || (indent >= fence.indent && !closes)) {
        out.push(line);
      } else if (closes && indent >= fence.indent && indent <= 3) {
        out.push(line);
        fence = undefined;
      } else if (closes && fence.indent === 0) {
        // 4 or more spaces in: code, not the closing fence.
        out.push(line);
      } else {
        // Its list item ended, or a fence the preview may or may not take as the end: nothing after it is surely code.
        fence = undefined;
        sure = false;
        prose.push(line);
      }
      continue;
    }
    const open = sure ? FENCE_OPEN.exec(line) : null;
    if (open) {
      flush();
      out.push(line);
      fence = { indent: indentOf(line), close: new RegExp(`^\\${open[1][0]}{${open[1].length},} *$`) };
      continue;
    }
    // A math block ($$) may hold what looks like a fence: nothing after it is surely code.
    if (line.includes("$$")) sure = false;
    prose.push(line);
  }
  flush();
  return out.join("\n");
}
