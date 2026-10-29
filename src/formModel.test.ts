import * as assert from "assert";
import { checkValues, fieldProblem, formProblems, initialValues, type FormSpec } from "./formModel";
import { releaseReport, releaseSpec } from "./releaseModel";

const spec: FormSpec = {
  id: "tagAcross", title: "Tag Across Repositories", submit: "Create Tag", cancel: "Cancel",
  fields: [
    { kind: "text", id: "name", label: "Tag name", rule: "ref", taken: ["v1.3.0"] },
    { kind: "text", id: "message", label: "Message (optional)", multiline: true },
    { kind: "check", id: "push", label: "Push", value: true },
    { kind: "list", id: "repos", label: "Repositories", required: "Tick at least one repository.", items: [
      { id: "acme-web", label: "acme-web", value: true }, { id: "acme-api", label: "acme-api", value: false }, { id: "acme-libs", label: "acme-libs", value: true, disabled: "unreadable" },
    ] },
  ],
};

{
  // A disabled item never starts ticked, whatever it says.
  assert.deepStrictEqual(initialValues(spec), { name: "", message: "", push: true, repos: ["acme-web"] });
  assert.strictEqual(fieldProblem(spec.fields[0], ""), "Enter a name.");
  assert.match(fieldProblem(spec.fields[0], "v1 .4") ?? "", /Not a valid name/);
  assert.strictEqual(fieldProblem(spec.fields[0], "v1.3.0"), "That name is already taken.");
  assert.strictEqual(fieldProblem(spec.fields[0], " v1.4.0 "), undefined);
  assert.deepStrictEqual(formProblems(spec, { ...initialValues(spec), name: "v1.4.0", repos: [] }), { repos: "Tick at least one repository." });
  console.log("ok - a review form starts from its fields and says what is wrong with each");
}

{
  // The page is not trusted: only this form's fields, of their kinds, offered items only.
  assert.deepStrictEqual(checkValues(spec, { name: " v1.4.0 ", message: "notes\n\n", push: false, repos: ["acme-api", "acme-libs", "elsewhere"], extra: 1 }),
    { name: "v1.4.0", message: "notes", push: false, repos: ["acme-api"] });
  assert.strictEqual(checkValues(spec, { name: "v1.4.0", message: "", push: "yes", repos: [] }), undefined, "wrong kind");
  assert.strictEqual(checkValues(spec, { name: "v1..4", message: "", push: true, repos: ["acme-web"] }), undefined, "invalid name");
  assert.strictEqual(checkValues(spec, { name: "v1.4.0", message: "", push: true, repos: [] }), undefined, "nothing ticked");
  assert.strictEqual(checkValues(spec, null), undefined);
  console.log("ok - the host checks a form's answer again: its own fields only, never a disabled item");
}

{
  const s = releaseSpec({ from: "develop", into: "main", notes: "## acme-web", push: true,
    rows: [{ id: "w", name: "acme-web", from: "develop", into: "main", commits: 4, how: "checked out: git merge" }, { id: "a", name: "acme-api", from: "develop", into: "main", commits: 1, how: "not checked out", noUpstream: true }],
    left: [{ name: "acme-libs", reason: "would conflict" }] });
  assert.strictEqual(s.title, "Release develop into main");
  assert.match(s.intro ?? "", /^Nothing runs until you press Release/);
  const repos = s.fields[0];
  assert.ok(repos.kind === "list");
  assert.deepStrictEqual(repos.items.map((i) => [i.label, i.description, i.value, i.disabled]), [
    ["acme-web", "develop → main · 4 commits", true, undefined], ["acme-api", "develop → main · 1 commit", true, undefined], ["acme-libs", undefined, false, "would conflict"]]);
  assert.deepStrictEqual(initialValues(s), { repos: ["w", "a"], tag: "", push: true });
  const push = s.fields[2];
  assert.ok(push.kind === "check" && /stays local in: acme-api/.test(push.hint ?? ""));
  assert.strictEqual(fieldProblem(s.fields[1], ""), undefined, "the tag is optional");
  assert.deepStrictEqual(releaseReport({ title: "Release develop into main", merged: ["acme-web"], stopped: [], tag: "v1.4.0", tagged: ["acme-web"], pushed: ["acme-web"], failures: [] }),
    { level: "info", text: "Release develop into main — Merged: acme-web. Tagged v1.4.0: acme-web. Pushed: acme-web." });
  assert.strictEqual(releaseReport({ title: "R", merged: [], stopped: ["acme-web"], tag: "", tagged: [], pushed: [], failures: ["acme-api (push: rejected)"] }).text,
    "R — Merged: none. Stopped on conflicts, resolve or abort: acme-web. Not done: acme-api (push: rejected).");
  console.log("ok - Release…'s one form before anything runs, and its one report");
}
