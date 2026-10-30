import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import type { CommitReference } from "../../commitReferences";
import { configureI18n } from "../../i18n";
import { containingBranches, referencePills } from "./referencePills";

const head: CommitReference = { kind: "head", name: "HEAD" };
const develop: CommitReference = { kind: "local", name: "develop", current: true };
const originDevelop: CommitReference = { kind: "remote", name: "origin/develop" };
const labels = (pills: { label: string }[][]) => pills.map((p) => p.map((s) => s.label).join(" | "));

{
  assert.deepStrictEqual(referencePills([]), []);
  const pills = referencePills([head, { kind: "local", name: "main" }, develop, originDevelop]);
  assert.deepStrictEqual(labels(pills), ["HEAD | develop | origin", "main"], "the checked-out branch first, HEAD named on its pill");
  assert.deepStrictEqual(pills[0].map((s) => s.kind), ["head", "local", "remote"]);
  assert.strictEqual(pills[0][1].current, true);
  assert.deepStrictEqual(labels(referencePills([head, { kind: "tag", name: "v1.4.0" }])), ["HEAD", "v1.4.0"], "a detached HEAD is a pill of its own");
  assert.strictEqual(referencePills([head])[0][0].kind, "detached");
  assert.deepStrictEqual(labels(referencePills([{ kind: "remote", name: "origin/release-1.4" }, { kind: "local", name: "main" }, { kind: "remote", name: "upstream/main" }, { kind: "remote", name: "origin/main" }])),
    ["main | upstream | origin", "origin/release-1.4"], "every remote of the same name joins the branch; a remote branch alone after the local ones");
  assert.deepStrictEqual(labels(referencePills([{ kind: "local", name: "x" }, { kind: "remote", name: "origin/feature/x" }])), ["x", "origin/feature/x"], "another branch ending in the same name stays apart");
  console.log("ok - the details' references are the Log's pills, HEAD named on the checked-out branch");
}

{
  configureI18n("en");
  // develop's tip, HEAD on it: the pills above name every branch that contains it.
  const tip = containingBranches([head, develop, originDevelop], [develop, originDevelop]);
  assert.deepStrictEqual(tip, { heading: "In no other branch.", pills: [] });
  // Further on in release-1.4 and its remote: one pill for both, the count says two.
  const more = containingBranches([head, develop, originDevelop], [develop, originDevelop, { kind: "local", name: "release-1.4" }, { kind: "remote", name: "origin/release-1.4" }]);
  assert.strictEqual(more.heading, "Also in 2 other branches:");
  assert.deepStrictEqual(labels(more.pills), ["release-1.4 | origin"]);
  assert.strictEqual(containingBranches([], [{ kind: "remote", name: "origin/main" }]).heading, "In 1 branch:");
  assert.strictEqual(containingBranches([develop], [develop, { kind: "local", name: "main" }]).heading, "Also in 1 other branch:");
  // An older commit: nothing points here, so the list is every branch, HEAD named on the checked-out one.
  const old = containingBranches([], [develop, originDevelop, { kind: "local", name: "release-1.4" }]);
  assert.strictEqual(old.heading, "In 3 branches:");
  assert.deepStrictEqual(labels(old.pills), ["HEAD | develop | origin", "release-1.4"]);
  // Only a detached HEAD holds it: no branch does, whether HEAD is here or further on.
  assert.deepStrictEqual(containingBranches([head], [head]), { heading: "Not in any branch.", pills: [] });
  const ahead = containingBranches([], [head]);
  assert.strictEqual(ahead.heading, "In 1 branch:");
  assert.deepStrictEqual(ahead.pills.map((p) => p[0].kind), ["detached"]);
  assert.strictEqual(containingBranches([{ kind: "tag", name: "v1.4.0" }], []).heading, "Not in any branch.", "a tag is no branch");
  console.log("ok - the containing branches leave out the ones the pills above already name");
}

{
  const zh = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "l10n/bundle.l10n.zh-cn.json"), "utf8")) as Record<string, string>;
  configureI18n("zh-cn", zh);
  assert.strictEqual(containingBranches([head, develop, originDevelop], [develop, originDevelop]).heading, "不在其他分支中。");
  assert.strictEqual(containingBranches([develop], [develop, originDevelop, { kind: "local", name: "main" }]).heading, "还在另外 2 个分支中：");
  assert.strictEqual(referencePills([head, develop])[0][0].title, "HEAD（已签出）");
  configureI18n("en");
  console.log("ok - the containing branches' headings in Chinese");
}
