// Dev-only: the host's answer to the Log's visibleAuthors, so avatars show in the harness. dana has
// a picture; rin has none, and her disc keeps its initial. Neutral names only (CLAUDE.md constraint 3).
import type { HostMessage, WebviewMessage } from "../../../src/protocol";

const WITH_PICTURE = new Set(["dana@example.com"]);
/** A real host needs a few requests: the answer comes a moment after the report. */
const ANSWER_MS = 300;

/** A 64 px picture drawn in the theme's own colors (constraint 2), as a data: URI like the host sends. */
function picture(letter: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const g = canvas.getContext("2d")!;
  const css = getComputedStyle(document.body);
  g.fillStyle = css.getPropertyValue("--vscode-charts-purple").trim();
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = css.getPropertyValue("--vscode-editor-background").trim();
  g.font = "600 34px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(letter, 32, 34);
  return canvas.toDataURL("image/png");
}

export function answerAvatars(m: Extract<WebviewMessage, { type: "visibleAuthors" }>, send: (m: HostMessage, delay?: number) => void): void {
  const byEmail: Record<string, string> = {};
  for (const { email } of m.authors) {
    const e = email.trim().toLowerCase();
    if (WITH_PICTURE.has(e)) byEmail[e] = picture(e[0].toUpperCase());
  }
  if (Object.keys(byEmail).length > 0) send({ type: "avatars", byEmail }, ANSWER_MS);
}
