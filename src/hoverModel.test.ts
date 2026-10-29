import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { configureI18n } from "./i18n";
import { authorLabel, bodyOf, countArgs, detailOf, filesLabel, isMine, mergeTargetLabel, parseCounts, pickMergeTarget, remoteHeadArgs, shortRemoteRef, showsMergeTarget, whenLabel } from "./hoverModel";

const zh = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "l10n/bundle.l10n.zh-cn.json"), "utf8")) as Record<string, string>;

{
  configureI18n("en");
  assert.ok(isMine("Dana@Example.com", "dana@example.com "));
  assert.ok(!isMine("rin@example.com", "dana@example.com"));
  assert.ok(!isMine("dana@example.com", undefined), "no user.email: nobody's commit is mine");
  assert.ok(!isMine("", ""), "an empty email is nobody's");
  assert.strictEqual(authorLabel("dana", true), "You");
  assert.strictEqual(authorLabel("dana", false), "dana");
  const t = new Date(2026, 8, 20, 12, 5).getTime() / 1000;
  assert.strictEqual(whenLabel(t + 3 * 86_400, t), "3d ago (2026-09-20 12:05)");
  configureI18n("zh-cn", zh);
  assert.strictEqual(authorLabel("dana", true), "你");
  assert.strictEqual(whenLabel(t + 120, t), "2 分钟前 (2026-09-20 12:05)");
  configureI18n("en");
  console.log("ok - the card says You for my commits and gives relative and absolute time");
}

{
  assert.strictEqual(bodyOf("feat: add retry"), "");
  assert.strictEqual(bodyOf("feat: add retry\n\n\nWhy it matters.\n\nCo-Authored-By: Rin <rin@example.com>\n\n"), "Why it matters.\n\nCo-Authored-By: Rin <rin@example.com>");
  assert.strictEqual(bodyOf("subject\r\n\r\nbody\r\n"), "body");
  const long = bodyOf(["subject", "", ...Array.from({ length: 40 }, (_, i) => `line ${i}`)].join("\n"));
  assert.strictEqual(long.split("\n").length, 24);
  assert.ok(long.endsWith("line 23…"));
  assert.ok(bodyOf(`s\n\n${"x".repeat(5000)}`).length <= 2001);
  console.log("ok - the body leaves out the subject and is cut to what a hover holds");
}

{
  // showArgs' output: the message, RS, then --raw and --numstat records (-z).
  const stdout = "feat: retry\n\nBody line.\x1e\n"
    + ":100644 100644 aaaaaaa bbbbbbb M\0src/client.ts\0:000000 100644 0000000 ccccccc A\0src/new.ts\0:100644 000000 ddddddd 0000000 D\0old.ts\0"
    + ":100644 100644 eeeeeee fffffff R100\0a.ts\0b.ts\0:100644 100644 1111111 2222222 M\0logo.png\0"
    + "\n12\t3\tsrc/client.ts\0" + "4\t0\tsrc/new.ts\0" + "0\t9\told.ts\0" + "0\t0\t\0a.ts\0b.ts\0" + "-\t-\tlogo.png\0";
  const d = detailOf(stdout);
  assert.strictEqual(d.message, "feat: retry\n\nBody line.");
  assert.deepStrictEqual(d.kinds, { added: 1, modified: 2, deleted: 1, renamed: 1 });
  assert.strictEqual(d.files, 5);
  assert.deepStrictEqual([d.added, d.deleted], [16, 12], "binary files add no lines");
  assert.deepStrictEqual(detailOf(""), { message: "", kinds: { added: 0, modified: 0, deleted: 0, renamed: 0 }, files: 0, added: 0, deleted: 0 });
  assert.strictEqual(filesLabel(1), "1 file changed");
  assert.strictEqual(filesLabel(6), "6 files changed");
  configureI18n("zh-cn", zh);
  assert.strictEqual(filesLabel(6), "6 个文件已更改");
  configureI18n("en");
  console.log("ok - one git show gives the whole message, files by kind and line totals");
}

{
  assert.deepStrictEqual(remoteHeadArgs("develop"), ["for-each-ref", "--format=%(refname)%00%(symref)%00%(upstream:remotename)", "refs/heads/develop", "refs/remotes/*/HEAD"]);
  const out = (lines: string[][]) => lines.map((l) => l.join("\0")).join("\n") + "\n";
  const both = out([["refs/heads/develop", "", "upstream"], ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", ""], ["refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk", ""]]);
  assert.strictEqual(pickMergeTarget(both, "develop"), "refs/remotes/upstream/trunk", "the upstream remote's default branch first");
  const noUpstream = out([["refs/heads/develop", "", ""], ["refs/remotes/fork/HEAD", "refs/remotes/fork/main", ""], ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", ""]]);
  assert.strictEqual(pickMergeTarget(noUpstream, "develop"), "refs/remotes/origin/main", "no upstream: origin");
  assert.strictEqual(pickMergeTarget(out([["refs/remotes/fork/HEAD", "refs/remotes/fork/main", ""]]), "develop"), "refs/remotes/fork/main", "the only remote");
  assert.strictEqual(pickMergeTarget(out([["refs/heads/develop", "", "origin"]]), "develop"), undefined, "no remote HEAD: no target");
  assert.strictEqual(pickMergeTarget(out([["refs/remotes/origin/HEAD", "refs/remotes/origin/a..b", ""]]), "develop"), undefined);
  assert.strictEqual(pickMergeTarget(out([["refs/remotes/origin/HEAD", "--output=x", ""]]), "develop"), undefined, "nothing but a remote branch reaches rev-list");
  assert.strictEqual(pickMergeTarget(out([["refs/remotes/a/HEAD", "refs/remotes/a/main", ""], ["refs/remotes/b/HEAD", "refs/remotes/b/main", ""]]), "x"), undefined, "several remotes, none origin: no guess");
  assert.deepStrictEqual(countArgs("a".repeat(40), "refs/remotes/origin/main"), ["rev-list", "--left-right", "--count", `${"a".repeat(40)}...refs/remotes/origin/main`, "--"]);
  assert.deepStrictEqual(parseCounts("3\t1\n"), { ahead: 3, behind: 1 });
  assert.strictEqual(parseCounts("fatal"), undefined);
  assert.strictEqual(shortRemoteRef("refs/remotes/origin/main"), "origin/main");
  console.log("ok - the merge target is the upstream remote's HEAD, counted with one rev-list");
}

{
  assert.ok(showsMergeTarget({ name: "origin/main", branch: "develop", ahead: 2, behind: 0 }));
  assert.ok(!showsMergeTarget({ name: "origin/main", branch: "main", ahead: 2, behind: 0 }), "main is not merged into origin/main");
  assert.ok(showsMergeTarget({ name: "origin/release-1.4", branch: "release", ahead: 0, behind: 0 }));
  assert.strictEqual(mergeTargetLabel({ name: "origin/main", branch: "develop", ahead: 2, behind: 0 }), "Merge target origin/main · 2 ahead");
  assert.strictEqual(mergeTargetLabel({ name: "origin/main", branch: "develop", ahead: 2, behind: 5 }), "Merge target origin/main · 2 ahead · 5 behind");
  assert.strictEqual(mergeTargetLabel({ name: "origin/main", branch: "develop", ahead: 0, behind: 0 }), "Merge target origin/main · up to date");
  configureI18n("zh-cn", zh);
  assert.strictEqual(mergeTargetLabel({ name: "origin/main", branch: "develop", ahead: 2, behind: 0 }), "合并目标 origin/main · 领先 2 个提交");
  configureI18n("en");
  console.log("ok - the merge target reads as GitLens says it, and is hidden for the branch itself");
}
