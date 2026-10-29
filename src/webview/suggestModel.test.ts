import * as assert from "assert";
import { hintParts, matchSuggestions, suggestKey, type Suggestion } from "./suggestModel";

const people: Suggestion[] = [
  { value: "dana", label: "dana", detail: "dana@example.com · 41" },
  { value: "rin", label: "rin", detail: "rin@example.com · 37" },
  { value: "noor", label: "noor", detail: "noor@example.com · 12" },
  { value: "sandra", label: "sandra", detail: "sandra@example.com · 3" },
];

{
  assert.deepStrictEqual(matchSuggestions(people, "").map((m) => m.item.value), ["dana", "rin", "noor", "sandra"], "no query: everything, in the host's order");
  assert.deepStrictEqual(matchSuggestions(people, "a").map((m) => m.item.value), ["dana", "sandra", "rin", "noor"], "names that match come first; a match only in the detail (the email) still counts");
  assert.deepStrictEqual(matchSuggestions(people, "SAN").map((m) => [m.item.value, m.label]), [["sandra", [0, 3]]], "case-insensitive, with the matched range for highlighting");
  assert.deepStrictEqual(matchSuggestions(people, "dr").map((m) => m.item.value), ["sandra"], "a substring, not only a prefix");
  assert.deepStrictEqual(matchSuggestions(people, "example.com").map((m) => m.label), [null, null, null, null], "detail-only match: nothing to highlight in the label");
  assert.strictEqual(matchSuggestions(people, "", 2).length, 2, "capped");
  assert.deepStrictEqual(matchSuggestions(people, "dana", 8, ["dana"]).map((m) => m.item.value), [], "already chosen values are left out");
  console.log("ok - suggestions: substring match on the name or the detail, names first, highlighted");
}
{
  assert.deepStrictEqual(suggestKey("ArrowDown", -1, 3), { active: 0 }, "↓ enters the list");
  assert.deepStrictEqual(suggestKey("ArrowDown", 2, 3), { active: 0 }, "and wraps, like VS Code's suggest widget");
  assert.deepStrictEqual(suggestKey("ArrowUp", 0, 3), { active: 2 });
  assert.deepStrictEqual(suggestKey("Enter", 1, 3), { pick: 1 }, "Enter picks the highlighted one");
  assert.deepStrictEqual(suggestKey("Tab", 1, 3), { pick: 1 }, "so does Tab");
  assert.strictEqual(suggestKey("Enter", -1, 3), null, "nothing highlighted: Enter is the box's own (add what was typed)");
  assert.deepStrictEqual(suggestKey("Escape", 0, 3), { close: true });
  assert.strictEqual(suggestKey("ArrowDown", -1, 0), null, "an empty list ignores keys");
  assert.strictEqual(suggestKey("a", 0, 3), null);
  console.log("ok - suggestion keys: ↑/↓ wrap, Enter and Tab pick, Esc closes");
}
{
  assert.deepStrictEqual(hintParts({ text: "Use a date, e.g. {0}, or {1}", code: ["after:2026-10-01", "since:3.weeks.ago"] }),
    [["Use a date, e.g. ", false], ["after:2026-10-01", true], [", or ", false], ["since:3.weeks.ago", true]], "text and code in order");
  assert.deepStrictEqual(hintParts({ text: "{1} 或 {0}", code: ["a", "b"] }), [["b", true], [" 或 ", false], ["a", true]], "a translation may reorder them");
  assert.deepStrictEqual(hintParts({ text: "Combine {0} and {2}", code: ["x"] }), [["Combine ", false], ["x", true], [" and {2}", false]], "a placeholder without code stays text");
  assert.deepStrictEqual(hintParts({ text: "Plain", code: [] }), [["Plain", false]]);
  console.log("ok - suggestion hints: examples drawn as code where the text puts them");
}
