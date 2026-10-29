import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

// One Chinese vocabulary across both catalogs (docs/glossary.zh-cn.md): the words it replaced stay out.
const root = path.resolve(__dirname, "..");
const catalogs = ["l10n/bundle.l10n.zh-cn.json", "package.nls.zh-cn.json"].map((f) => [f, JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as Record<string, string>] as const);
const banned: [RegExp, string][] = [
  [/检出/, "checkout is 签出"],
  [/优选/, "cherry-pick is 拣选"],
  [/贮藏/, "stash is 储藏"],
  [/游离/, "detached HEAD is 分离 HEAD"],
  [/提交说明/, "commit message is 提交信息"],
  [/复制提交 ID/, "Copy Commit ID/SHA/Hash is 复制提交哈希"],
  [/拓扑/, "Topological order is 按分支结构"],
  [/忘掉/, "Forget is 清除记录"],
  [/工作树更改/, "working-tree changes are 工作区更改 (工作树 is a worktree)"],
  [/回滚/, "Discard Changes is 放弃更改"],
  [/发布/, "Release… is 发版…; Publish is 推送到远程"],
  [/(^|[^A-Za-z])Log([^A-Za-z]|$)/, "the Log in a Chinese sentence is 日志"],
];
for (const [file, catalog] of catalogs) {
  for (const [key, value] of Object.entries(catalog)) {
    for (const [word, why] of banned) assert.ok(!word.test(value), `${file}: ${JSON.stringify(key)} → ${value}: ${why}`);
  }
}
const zh = catalogs[0][1], nls = catalogs[1][1];
assert.strictEqual(zh["Release…"], "发版…");
assert.strictEqual(nls["command.linyra.commitCheckout.title"], "签出此提交");
assert.strictEqual(nls["command.linyra.repoHide.title"], "取消勾选");
assert.strictEqual(nls["command.linyra.repoExclude.title"], "永久排除（写入设置）");
assert.strictEqual(zh["Left and Right Side by Side"], "左右排列");
assert.strictEqual(zh["Left Above Right"], "上下排列");
console.log("ok - one Chinese vocabulary in both catalogs (签出, 拣选, 储藏, 分离 HEAD, 提交信息, 发版, 放弃更改…)");
