import * as assert from "assert";
import { commitDetails, detailHeight } from "./changesPresentation";
import type { ChangesState } from "./changesModel";
import { UNCOMMITTED } from "./types";
import { renderChangesHtml } from "./webview/changes/html";

const state: ChangesState = {
  commit: { repoId: "/ws/acme-web", sha: "a".repeat(40), subject: "feat: preserve commit details", author: "dana", email: "dana@example.com", time: 1_800_000_000, parents: [] },
  repoName: "acme-web", repoRoot: "/ws/acme-web", files: [], status: "ready",
  message: "feat: preserve commit details\n\nFirst paragraph.\n\n- Keep line breaks\n- Keep <literal> markup\n\nCo-Authored-By: Rin <rin@example.com>",
};
{
  const [detail] = commitDetails(state, null);
  assert.strictEqual(detail.title, state.commit.subject);
  assert.strictEqual(detail.body, "First paragraph.\n\n- Keep line breaks\n- Keep <literal> markup\n\nCo-Authored-By: Rin <rin@example.com>");
  assert.strictEqual(detail.sha, state.commit.sha);
  assert.strictEqual(detail.email, state.commit.email);
  assert.deepStrictEqual(commitDetails({ ...state, message: state.message.replace(/\n/g, "\r\n") }, null), [detail]);
  assert.strictEqual(commitDetails({ ...state, message: "", status: "loading" }, null)[0].body, "");
  assert.deepStrictEqual(commitDetails(null, null), []);
  assert.deepStrictEqual(commitDetails({ ...state, commit: { ...state.commit, sha: UNCOMMITTED } }, null), []);
  console.log("ok - commit details preserve paragraphs, trailers and literal text; pending work has no commit");
}
{
  const combined = { status: "ready" as const, count: 2, noNetChange: [], unselected: {}, repos: [{ repoId: state.commit.repoId, repoName: state.repoName, accent: 0, commits: [state.commit, { ...state.commit, sha: "b".repeat(40), subject: "fix: upload empty files" }], files: [] }] };
  assert.deepStrictEqual(commitDetails(null, combined).map((c) => c.title), [state.commit.subject, "fix: upload empty files"]);
  console.log("ok - combined selection retains the selected commits' identity and subjects");
}
{
  assert.strictEqual(detailHeight(200, 600), 200);
  assert.strictEqual(detailHeight(10_000, 600), 498);
  assert.strictEqual(detailHeight(-100, 600), 96);
  assert.strictEqual(detailHeight(NaN, 600), 240);
  assert.strictEqual(detailHeight(Infinity, 600), 498);
  assert.strictEqual(detailHeight(200, 0), 0);
  for (const height of [40, 80, 120, 180, 250, 600]) {
    const detail = detailHeight(10_000, height);
    assert.ok(detail >= 0 && detail <= height - 6);
    assert.ok(height - 6 - detail >= Math.min(96, (height - 6) * 0.4) - 1, "files remain reachable");
  }
  assert.strictEqual(detailHeight(200, 600), 200, "clamping a small viewport does not change the remembered preference");
  console.log("ok - divider bounds keep both panes usable at short and tall sizes");
}
{
  const html = renderChangesHtml({ nonce: "test", cspSource: "vscode-resource:", scriptUri: "changes.js", styleUri: "changes.css" });
  assert.ok(html.includes('role="separator" aria-orientation="horizontal"'));
  assert.ok(html.includes('aria-controls="commit-details" tabindex="0"'));
  assert.ok(html.includes('role="tree" aria-multiselectable="true"'));
  assert.ok(html.includes('id="changes-tree-toggle"'));
  assert.ok(!html.includes('id="expand"') && !html.includes('id="collapse"'), "one button alternates the tree action");
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(html.indexOf('id="linyra-i18n"') < html.indexOf('src="changes.js"'));
  console.log("ok - changes shell exposes the keyboard divider and tree under the webview CSP");
}
