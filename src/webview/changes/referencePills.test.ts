import * as assert from "assert";
import { referencePills } from "./referencePills";

{
  assert.deepStrictEqual(referencePills([]), []);
  assert.deepStrictEqual(referencePills([{ kind: "head", name: "HEAD" }, { kind: "local", name: "main" }, { kind: "remote", name: "origin/main" }]), [
    [{ kind: "local", label: "main" }, { kind: "remote", label: "origin", title: "origin/main" }],
  ], "a branch and its remote share one pill; HEAD on a branch is not one of its own");
  assert.deepStrictEqual(referencePills([{ kind: "head", name: "HEAD" }, { kind: "tag", name: "v1.4.0" }]), [
    [{ kind: "detached", label: "HEAD" }], [{ kind: "tag", label: "v1.4.0" }],
  ], "a detached HEAD is a pill");
  assert.deepStrictEqual(referencePills([{ kind: "remote", name: "origin/release-1.4" }, { kind: "local", name: "main" }, { kind: "remote", name: "upstream/main" }, { kind: "remote", name: "origin/main" }]), [
    [{ kind: "local", label: "main" }, { kind: "remote", label: "upstream", title: "upstream/main" }, { kind: "remote", label: "origin", title: "origin/main" }],
    [{ kind: "remote", label: "origin/release-1.4" }],
  ], "every remote of the same name joins the branch; a remote branch alone comes last");
  console.log("ok - the details' references become branch pills: branch with its remotes, tags, a detached HEAD");
}
