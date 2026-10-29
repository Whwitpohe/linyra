import assert from "node:assert/strict";
import { initials } from "./initials";

assert.equal(initials("dana"), "D");
assert.equal(initials("Dana Lee"), "DL");
assert.equal(initials("rin"), "R");
assert.equal(initials("zhang san"), "ZS");
assert.equal(initials("dana.lee"), "DL", "dots and dashes split words as spaces do");
assert.equal(initials("  "), "?");
console.log("ok - initials: first letters of the first and last word");

assert.equal(initials("张三"), "三");
assert.equal(initials("李 小龙"), "龙", "spaces inside a CJK name are ignored");
assert.equal(initials("さくら"), "ら");
console.log("ok - initials: a CJK name gives its last character");

assert.equal(initials("Émile Zola"), "ÉZ");
assert.equal(initials("dana <dana@example.com>"), "D", "an email in angle brackets is not part of the name");
console.log("ok - initials: accents kept, an email ignored");
