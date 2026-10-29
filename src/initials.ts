// An author's initial, for the graph's node and the commit hover card. Pure: no DOM, no vscode.

/** CJK, kana and hangul: a name written without spaces, family name first. */
const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/u;

/**
 * One or two letters for a name: "dana" → D, "Dana Lee" → DL, "zhang san" → ZS. A CJK name gives
 * its last character: family names repeat too often (王, 李, 张) to tell people apart.
 */
export function initials(name: string): string {
  const s = name.replace(/<[^>]*>/g, "").trim();
  if (CJK.test(s)) return [...s.replace(/\s+/g, "")].at(-1) ?? "?";
  const words = s.split(/[\s._@-]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : "";
  return (first + last).toLocaleUpperCase();
}
