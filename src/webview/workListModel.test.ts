import * as assert from "assert";
import { configureI18n } from "../i18n";
import type { BranchStatus } from "../workingTree";
import { meterParts, totalsTitle, workPill } from "./workListModel";

const b = (o: Partial<BranchStatus>): BranchStatus => ({ name: "develop", upstream: "origin/develop", ahead: 0, behind: 0, ...o });
const H = "abc1234".padEnd(40, "0");
configureI18n("en");
{
  assert.deepStrictEqual(workPill(b({ ahead: 1, behind: 2 }), H), [{
    kind: "local", label: "develop", current: true, ahead: 1, behind: 2,
    title: "develop · origin/develop · 2 commits to pull from its upstream, 1 commit not pushed",
  }], "⎇ develop ↑1 ↓2: the distance, its upstream in the title");
  assert.deepStrictEqual(workPill(b({}), H), [
    { kind: "local", label: "develop", current: true, title: "develop" },
    { kind: "remote", label: "", title: "up to date with origin/develop" },
  ], "in step with its upstream: a cloud, no numbers");
  assert.deepStrictEqual(workPill(b({ upstream: null }), H), [{ kind: "local", label: "develop", current: true, unpublished: true, title: "develop · no upstream" }], "no upstream: unpublished");
  assert.deepStrictEqual(workPill(b({ gone: true }), H), [{ kind: "local", label: "develop", current: true, unpublished: true, title: "develop · its upstream origin/develop is gone" }],
    "a gone upstream: unpublished again, and the title says why");
  assert.deepStrictEqual(workPill(b({ uncounted: true }), H), [{ kind: "local", label: "develop", current: true, title: "develop · differs from origin/develop" }], "uncounted: no cloud, no numbers");
  assert.deepStrictEqual(workPill(b({ name: null, upstream: null }), H), [{ kind: "detached", label: "abc1234", title: "HEAD detached at abc1234" }], "detached: its commit");
  assert.deepStrictEqual(workPill(b({ name: "main", upstream: null }), null)[0].unpublished, true, "before the first commit: the branch to be, unpublished");
  assert.strictEqual(workPill(b({ name: null, upstream: null }), null)[0].label, "HEAD");
  console.log("ok - an Uncommitted row's branch pill: distance, in step (☁), unpublished, gone, detached");
}
{
  assert.strictEqual(totalsTitle({ added: 1, modified: 3, deleted: 1, renamed: 0 }, { repos: 3, added: 24, deleted: 5 }), "1 new, 3 modified, 1 deleted\n3 repositories · 24 lines added, 5 deleted");
  assert.strictEqual(totalsTitle({ added: 0, modified: 1, deleted: 0, renamed: 0 }, { repos: 1, added: 2, deleted: 0 }), "1 modified\n1 repository · 2 lines added, 0 deleted");
  console.log("ok - the header totals' tooltip: files by kind, then repositories and lines");
}
{
  assert.deepStrictEqual(meterParts({ added: 1, modified: 2, deleted: 1, renamed: 0 }).map((p) => [p.kind, p.share]), [["added", 0.25], ["modified", 0.5], ["deleted", 0.25]]);
  assert.deepStrictEqual(meterParts({ added: 0, modified: 1, deleted: 0, renamed: 1 }).map((p) => p.kind), ["modified", "renamed"], "a rename has its own color");
  assert.deepStrictEqual(meterParts({ added: 0, modified: 3, deleted: 0, renamed: 0 }).map((p) => p.kind), ["modified"], "empty kinds are left out");
  assert.deepStrictEqual(meterParts({ added: 0, modified: 0, deleted: 0, renamed: 0 }), []);
  console.log("ok - the change meter beside a row's counts");
}
