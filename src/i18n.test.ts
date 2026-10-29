import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import { agoText } from "./blameModel";
import { decorationFor, describeChanges, stat } from "./changesModel";
import { summaryLabel } from "./compareModel";
import { DEFAULT_FILTER } from "./filterModel";
import { configureI18n, localize } from "./i18n";
import { describeUncommitted, discardPrompt, tags, type RepoWork } from "./uncommittedModel";
import { fetchSummary, syncLabel } from "./upstream";
import { renderReposHtml } from "./webview/compare/html";
import { renderHtml } from "./webview/html";
import { countLabel, emptyState, relativeTime } from "./webview/view";

const root = path.resolve(__dirname, "..");
const zh = JSON.parse(fs.readFileSync(path.join(root, "l10n/bundle.l10n.zh-cn.json"), "utf8")) as Record<string, string>;
const opts = { cspSource: "vscode-resource:", nonce: "localization-test", scriptUri: "webview.js", styleUri: "webview.css" };

{
  configureI18n("en");
  assert.strictEqual(localize("{0}: {1}", "{1}", "$&"), "{1}: $&");
  configureI18n("zh-cn", zh);
  assert.strictEqual(localize("No matching commits"), "没有匹配的提交");
  assert.strictEqual(localize("Unknown message {0}", "{1}"), "Unknown message {1}");
  configureI18n("fr");
  assert.strictEqual(countLabel(2), "2 commits");
  assert.strictEqual(localize("toString"), "toString");
  console.log("ok - unsupported locales and missing keys fall back to English; arguments stay literal");
}

{
  configureI18n("zh-cn", zh);
  assert.strictEqual(countLabel(2), "2 个提交");
  assert.strictEqual(relativeTime(120, 0), "2 分钟前");
  assert.strictEqual(agoText(0, 7200), "2 小时前");
  assert.strictEqual(decorationFor("M")?.tooltip, "已修改");
  assert.strictEqual(decorationFor("M")?.badge, "M");
  assert.strictEqual(describeChanges(null, 0).message, "在日志中选择提交以查看更改的文件。");
  assert.strictEqual(describeUncommitted([]).message, "勾选的仓库中没有未提交的更改。");
  assert.strictEqual(stat({ path: "note.txt", added: null, deleted: null, staged: true }), "二进制 · 已暂存");
  assert.ok(summaryLabel([{ kind: "missing" }], 1).includes("1 个缺少分支"));
  assert.ok(syncLabel({ ahead: 1, behind: 2 })?.title.includes("2 个提交"));
  assert.ok(fetchSummary(2, 0).includes("2 个仓库"));
  const state = emptyState({ repoCount: 1, filter: { ...DEFAULT_FILTER, text: "{0}" } });
  assert.strictEqual(state.title, "没有匹配的提交");
  assert.ok(state.body.includes("“{0}”"));
  assert.strictEqual(state.action?.id, "clearText");
  const f = { path: "new.txt", status: "A" as const, added: 1, deleted: 0, untracked: true };
  const work: RepoWork = { repoId: "acme-api", root: "/work/acme-api", name: "acme-api", head: null, staged: [f], changes: [], editedAt: null, canStage: true };
  assert.deepStrictEqual(tags(work), ["全部已暂存"]);
  const tree = describeUncommitted([work]).roots[0];
  assert.strictEqual(tree.children[0].children[0].description, "新增");
  const binaryWork = { ...work, staged: [{ ...f, untracked: false, added: null, deleted: null }] };
  assert.strictEqual(describeUncommitted([binaryWork]).roots[0].children[0].children[0].description, "二进制");
  assert.strictEqual(tree.children[0].label, "已暂存");
  assert.strictEqual(tree.children[0].group, "staged");
  const prompt = discardPrompt("acme-api", [f], true, [f]);
  assert.strictEqual(prompt.button, "放弃文件更改");
  assert.ok(prompt.detail.includes("无法撤销") && prompt.detail.includes("删除新文件"));
  configureI18n("en");
  assert.strictEqual(decorationFor("M")?.tooltip, "Modified");
  assert.strictEqual(describeUncommitted([]).message, "No uncommitted changes in the ticked repositories.");
  console.log("ok - native models, prompts, counts and status labels translate without changing action identifiers");
}

{
  configureI18n("zh-cn", zh);
  for (const render of [renderHtml, renderReposHtml]) {
    const html = render(opts);
    assert.ok(html.includes('<html lang="zh-cn">'));
    assert.ok(html.includes('aria-label="刷新"'));
    assert.ok(html.indexOf('id="linyra-i18n"') < html.indexOf('src="webview.js"'));
    const data = /<script id="linyra-i18n"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(data);
    assert.deepStrictEqual(JSON.parse(data), { language: "zh-cn", bundle: zh });
  }
  const malicious = '</script><img src=x onerror="alert(1)">&\u2028';
  configureI18n('en" onload="bad', { Refresh: malicious });
  const html = renderHtml(opts);
  assert.ok(!html.includes(malicious));
  assert.ok(html.includes('&lt;/script&gt;&lt;img'));
  assert.ok(!html.includes('<html lang="en" onload='));
  const data = /<script id="linyra-i18n"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1];
  assert.strictEqual(JSON.parse(data).bundle.Refresh, malicious);
  configureI18n("en");
  assert.ok(renderHtml(opts).includes('placeholder="Search commits, e.g. fix author:@me file:*.ts"'));
  console.log("ok - both HTML shells transfer the locale before startup and escape translated text and JSON safely");
}

{
  const placeholders = (text: string) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort();
  for (const [key, value] of Object.entries(zh)) {
    assert.ok(value.trim(), `empty translation: ${key}`);
    assert.deepStrictEqual(placeholders(value), placeholders(key), `translation loses placeholders: ${key}`);
  }
  function checkSources(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) checkSources(file);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const source = fs.readFileSync(file, "utf8");
        for (const match of source.matchAll(/localize\(\s*("(?:[^"\\]|\\.)*")/g)) {
          const key = JSON.parse(match[1]) as string;
          assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `${file}: missing ${key}`);
        }
        const literals = (node: ts.Expression): string[] => ts.isStringLiteral(node) ? [node.text]
          : ts.isConditionalExpression(node) ? [...literals(node.whenTrue), ...literals(node.whenFalse)] : [];
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "localize" && node.arguments[0]) {
            for (const key of literals(node.arguments[0])) assert.ok(Object.prototype.hasOwnProperty.call(zh, key), `${file}: missing conditional translation ${key}`);
          }
          ts.forEachChild(node, visit);
        };
        visit(ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
      }
    }
  }
  checkSources(path.join(root, "src"));
  const en = JSON.parse(fs.readFileSync(path.join(root, "package.nls.json"), "utf8")) as Record<string, string>;
  const manifestZh = JSON.parse(fs.readFileSync(path.join(root, "package.nls.zh-cn.json"), "utf8")) as Record<string, string>;
  assert.deepStrictEqual(Object.keys(en).sort(), Object.keys(manifestZh).sort());
  for (const key of Object.keys(en).filter((key) => key.startsWith("command.") || key.startsWith("view."))) {
    assert.notStrictEqual(manifestZh[key], en[key], `native menu or view was not translated: ${key}`);
  }
  for (const match of fs.readFileSync(path.join(root, "package.json"), "utf8").matchAll(/%([^%]+)%/g)) {
    assert.ok(en[match[1]] && manifestZh[match[1]], `missing manifest token ${match[1]}`);
  }
  console.log("ok - runtime catalogs preserve placeholders and all static source and manifest keys have translations");
}
