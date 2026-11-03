import * as assert from "assert";
import { notificationText, safeMarkdown } from "./untrusted";

{
  assert.strictEqual(notificationText("Done. [Open settings](command:workbench.action.openSettings) now."), "Done. [Open settings] (command:workbench.action.openSettings) now.");
  assert.ok(!notificationText("[[x](command:a)](command:b)").includes("]("), "nested links lose every \"](\"");
  assert.strictEqual(notificationText("dana's 3 commits in acme-api (since Monday)"), "dana's 3 commits in acme-api (since Monday)");
  console.log("ok - a notification never gets a live link from a model's answer");
}

{
  const EVIL = "https://evil.example/?d=";
  // Images, whatever their form: the Markdown shows as text and nothing is loaded.
  for (const image of [`![x](${EVIL}1)`, `![x][r]\n\n[r]: ${EVIL}2`, `![r]\n\n[r]: ${EVIL}3`, `![x](<${EVIL}4>)`, `[![x](${EVIL}5)](https://example.com)`]) {
    const safe = safeMarkdown(image);
    assert.ok(!/!\[/.test(safe) && safe.includes("!\\["), `${image} -> ${safe}`);
  }
  // Raw HTML that loads something: escaped, inline, as a block, over lines, after container marks.
  for (const html of [
    `see <img src="${EVIL}6"> here`, `<img src="${EVIL}7">`, `<div style="background:url(${EVIL}8)"`,
    `text <span\nstyle="background:url(${EVIL}9)">x</span>`, `> text <span\n> style="background:url(${EVIL}10)">x</span>`,
    `> <link rel="stylesheet" href="${EVIL}11">`, `- <video poster="${EVIL}12">`, `1. <STYLE>body{background:url(${EVIL}13)}</style>`,
    `a <style>body{background:url(${EVIL}14)}</style>`, `<!-- hidden --><img src=${EVIL}15>`, `x <svg><image href="${EVIL}16"/></svg>`,
  ]) {
    const safe = safeMarkdown(html);
    assert.ok(!/<(img|div|span|link|video|style|svg|image|!)/i.test(safe), `${html} -> ${safe}`);
  }
  // What loads nothing stays as written.
  const prose = "Uses `Map<string, number>` and `Array<string | number>`, wraps it in <details>, closes </p>, adds a line<br/>.\n\n- **bold** [docs](https://example.com/acme-web) and `code`";
  assert.strictEqual(safeMarkdown(prose), prose);
  console.log("ok - model Markdown: images and HTML that would load a URL are neutralized; text, links and harmless tags stay");
}

{
  const EVIL = "https://evil.example/?d=";
  // Code blocks are kept as they are: at the top level, in a list item, with tildes, unclosed at the end.
  const kept = [
    "Before:\n\n```html\n<img src=\"https://cdn.example/logo.png\">\n![logo](https://cdn.example/logo.png)\n```\n\nAfter.",
    "1. Add it:\n   ```ts\n   const m: Map<string, number> = new Map();\n   const el = <div className=\"x\" />;\n   ```\n2. Done.",
    "~~~\n<style>a{}</style>\n~~~",
    "```md\n![still code](https://cdn.example/x.png)",
    "```\n    ```\n<img src=x>\n```",
  ];
  for (const md of kept) assert.strictEqual(safeMarkdown(md), md, md);
  assert.strictEqual(safeMarkdown("a\r\n```\r\n<img src=x>\r\n```\r\n"), "a\n```\n<img src=x>\n```\n", "CRLF read as lines");
  // Where the preview may not read a code block, nothing is kept as code.
  const unsure = [
    // A fence in a list item ends with the item; the next fence opens, not closes.
    `- a\n  \`\`\`\n  x\n\`\`\`\n![e](${EVIL}1)\n\`\`\`\n![f](${EVIL}2)`,
    // Indented 4 spaces after a paragraph: its text, not a fence.
    `para\n    \`\`\`\n    ![e](${EVIL}3)\n    \`\`\``,
    // Front matter and math blocks are the preview's plugins' to delimit.
    `---\n\`\`\`\n---\n![e](${EVIL}4)\n\`\`\``,
    `$$\n\`\`\`\n$$\n![e](${EVIL}5)\n\`\`\``,
    // An info string the preview may not take as one.
    `\`\`\`js \`x\`\n![e](${EVIL}6)\n\`\`\``,
  ];
  for (const md of unsure) assert.ok(!/!\[e\]|!\[f\]/.test(safeMarkdown(md)), `${md} -> ${safeMarkdown(md)}`);
  console.log("ok - model Markdown: code blocks kept as written where the preview surely reads them, nothing kept where it may not");
}
