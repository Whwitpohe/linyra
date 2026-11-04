import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { commitAt, gitEnv, makeRepo } from "../../fixtures";
import { DEFAULT_EXCLUDE, excludedBy } from "../profileModel";
import { budgetDiffs, splitPatch } from "./context";
import { commitPatchArgs, parseCommitPatch, rangePatchArgs, wipPatchArgs } from "./gitText";

{
  // Real git: whatever the user's diff config, the paths read from a patch are the repository's,
  // so linyra.ai.exclude leaves the same files out (a name with a space included).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-ai-patch-"));
  try {
    const root = path.join(home, "acme-api");
    const files = { "server key.pem": "SECRET=0\n", "config/secrets.json": "{\"token\": 0}\n", "docs/read me.md": "one\n", "src/app.ts": "export const a = 1;\n" };
    makeRepo(root, [{ time: 1000, author: "dana", message: "feat: base", files }], home);
    const git = (config: string[], args: string[]) => execFileSync("git", ["-c", "core.quotepath=off", ...config, ...args], { cwd: root, env: gitEnv(home), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const head = git([], ["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(root, "server key.pem"), "SECRET=1\n");
    fs.writeFileSync(path.join(root, "config/secrets.json"), "{\"token\": 1}\n");
    fs.writeFileSync(path.join(root, "docs/read me.md"), "one\ntwo\n");
    fs.writeFileSync(path.join(root, "src/app.ts"), "export const a = 2;\n");
    const exclude = [...DEFAULT_EXCLUDE, "config/secrets.json"];
    const all = ["config/secrets.json", "docs/read me.md", "server key.pem", "src/app.ts"];
    for (const config of [[], ["-c", "diff.mnemonicPrefix=true"], ["-c", "diff.noprefix=true"]]) {
      const name = config[1] ?? "no diff config";
      const wip = splitPatch(git(config, wipPatchArgs(head)));
      assert.deepStrictEqual(wip.map((f) => f.path).sort(), all, `${name}: the paths as the repository names them`);
      const sent = budgetDiffs(wip, (p) => excludedBy(exclude, p, false));
      assert.deepStrictEqual(sent.left.map((l) => l.path).sort(), ["config/secrets.json", "server key.pem"], `${name}: both secrets are left out`);
      assert.ok(!/SECRET|token/.test(sent.sections.join("")), `${name}: no excluded file's text is sent`);
      // Generate Commit Message reads only the checked files and keeps those whose path it asked for.
      const only = splitPatch(git(config, wipPatchArgs(head, ["docs/read me.md"])));
      assert.deepStrictEqual(only.map((f) => f.path), ["docs/read me.md"], `${name}: a checked file with a space is found again`);
    }
    commitAt(root, home, { time: 2000, author: "rin", message: "feat: rotate" });
    for (const config of [[], ["-c", "diff.mnemonicPrefix=true"], ["-c", "diff.noprefix=true"]]) {
      const name = config[1] ?? "no diff config";
      const shown = parseCommitPatch(git(config, commitPatchArgs("HEAD")));
      assert.deepStrictEqual(shown.files.map((f) => f.path).sort(), all, `${name}: a commit's paths`);
      const range = splitPatch(git(config, rangePatchArgs(head, "HEAD")));
      assert.ok(budgetDiffs(range, (p) => excludedBy(exclude, p, false)).left.length === 2, `${name}: a range's secrets are left out`);
    }
    fs.renameSync(path.join(root, "docs/read me.md"), path.join(root, "docs/read me too.md"));
    git([], ["add", "-A"]);
    const renamed = splitPatch(git(["-c", "diff.mnemonicPrefix=true"], wipPatchArgs(git([], ["rev-parse", "HEAD"]).trim())));
    assert.deepStrictEqual(renamed.map((f) => [f.path, f.oldPath]), [["docs/read me too.md", "docs/read me.md"]], "a rename with spaces keeps both names");
    console.log("ok - real git: patch paths ignore diff.mnemonicPrefix and diff.noprefix, and a name with a space stays excluded");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
