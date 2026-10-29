import * as assert from "assert";
import { LINE_LIMIT, messageHints, splitTemplate } from "./commitMessageModel";

{
  assert.deepStrictEqual(messageHints(""), []);
  assert.deepStrictEqual(messageHints("fix: guard nil response\n\nThe uploader retried forever."), [], "a good message: no hint");
  const long = "feat: ".padEnd(LINE_LIMIT + 8, "x");
  assert.deepStrictEqual(messageHints(long), [`The subject is ${LINE_LIMIT + 8} characters: keep it to ${LINE_LIMIT}.`]);
  assert.deepStrictEqual(messageHints("fix: one\nno blank line"), ["Leave the second line empty: it separates the subject from the body."]);
  assert.deepStrictEqual(messageHints(`fix: one\n\nshort\n${"y".repeat(80)}`), ["Line 4 is 80 characters: wrap the body at 72."]);
  assert.deepStrictEqual(messageHints(`fix: one\n\nSee https://example.com/${"a".repeat(80)}\nCo-authored-by: Rin Example <rin@example.com> and a very long trailer value past the limit`), [], "links and trailers are not wrapped");
  assert.deepStrictEqual(messageHints(`# a comment git strips ${"z".repeat(80)}\n\nfix: one`), [], "comments and leading blank lines do not count");
  assert.deepStrictEqual(messageHints("修复：上传".padEnd(73, "长")), ["The subject is 73 characters: keep it to 72."], "characters, not bytes");
  console.log("ok - the message's checks: a long subject, no blank line after it, a long body line");
}

{
  assert.deepStrictEqual(splitTemplate("# Why is this change needed?\n# What does it do?\n"), { text: "", hint: "Why is this change needed?\nWhat does it do?" });
  assert.deepStrictEqual(splitTemplate("feat: \r\n\r\nRefs: ACME-\r\n# Keep the subject short\r\n"), { text: "feat: \n\nRefs: ACME-", hint: "Keep the subject short" });
  assert.deepStrictEqual(splitTemplate(""), { text: "", hint: "" });
  console.log("ok - commit.template: its text prefills the box, its # guidance is the placeholder");
}
