import * as assert from "assert";
import { failureReason, reasonOf } from "./actionErrors";

{
  const cases: [string, RegExp | undefined][] = [
    [" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'origin'", /run Update Project, then push again/],
    ["error: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind", /run Update Project/],
    [" ! [rejected]        main -> main (stale info)", /moved since the last fetch/],
    ["CONFLICT (content): Merge conflict in src/a.ts\nAutomatic merge failed; fix conflicts and then commit the result.", /resolve them in Source Control, or abort/],
    ["error: The branch 'acme-feature' is not fully merged.", /not merged anywhere else/],
    ["error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt\nPlease commit your changes or stash them before you switch branches.", /commit or stash them first/],
    ["error: The following untracked working tree files would be overwritten by merge:\n\tnew.txt", /new files are in the way/],
    ["fatal: The current branch acme-feature has no upstream branch.", /push it once to set one/],
    ["fatal: Authentication failed for 'https://example.com/acme-web.git/'", /refused the sign-in/],
    ["git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", /refused the sign-in/],
    ["fatal: unable to access 'https://example.com/acme-web.git/': Could not resolve host: example.com", /could not be reached/],
    ["fatal: Not possible to fast-forward, aborting.", /diverged from its upstream/],
    ["fatal: a branch named 'acme-feature' already exists", /already taken/],
    ["fatal: something new", undefined],
  ];
  for (const [stderr, expected] of cases) {
    const reason = failureReason(stderr);
    if (expected) assert.match(reason ?? "", expected, stderr);
    else assert.strictEqual(reason, undefined, stderr);
  }
  // Nothing fits: git's own line, without "fatal:" and the trailing period.
  assert.strictEqual(reasonOf("hint: x\nfatal: something new."), "something new");
  assert.strictEqual(reasonOf("CONFLICT (content): Merge conflict in a.txt"), "files conflict: resolve them in Source Control, or abort");
  console.log("ok - git's common refusals in a few words, with what to do next");
}
