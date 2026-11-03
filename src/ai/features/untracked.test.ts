import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { untrackedDiff } from "./untracked";

void (async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-ai-untracked-"));
  try {
    const root = path.join(home, "acme-web");
    const outside = path.join(home, "credentials");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(outside, "aws_secret_access_key = OUTSIDE-SECRET\n");
    fs.writeFileSync(path.join(root, "src/new.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(root, "inside.txt"), "INSIDE-TEXT\n");

    const file = await untrackedDiff(root, "src/new.ts", 64 * 1024);
    assert.ok(file?.text.includes("+++ b/src/new.ts") && file.text.includes("+export const a = 1;"), "a regular file: its text");
    const cut = await untrackedDiff(root, "src/new.ts", 6);
    assert.ok(cut?.text.includes("+export") && !cut.text.includes("const"), "read no further than asked");
    assert.strictEqual(await untrackedDiff(root, "src", 1024), undefined, "a folder is not a file");
    assert.strictEqual(await untrackedDiff(root, "../credentials", 1024), undefined, "a path out of the repository");
    assert.strictEqual(await untrackedDiff(root, "missing.txt", 1024), undefined);

    let links = true;
    try {
      fs.symlinkSync(outside, path.join(root, "aws"));
    } catch {
      links = false; // Windows without the right to make links
    }
    if (links) {
      fs.symlinkSync("inside.txt", path.join(root, "alias.txt"));
      fs.symlinkSync(home, path.join(root, "up"), "dir");
      const link = await untrackedDiff(root, "aws", 64 * 1024);
      assert.ok(link?.text.includes("new file mode 120000") && link.text.includes(`+${outside}`), "a link: its target path, as git records it");
      assert.ok(!link?.text.includes("OUTSIDE-SECRET"), "never what it points at");
      const alias = await untrackedDiff(root, "alias.txt", 64 * 1024);
      assert.ok(alias?.text.includes("+inside.txt") && !alias.text.includes("INSIDE-TEXT"), "a link inside the repository too: only the path");
      assert.strictEqual(await untrackedDiff(root, "up/credentials", 1024), undefined, "not through a linked folder");
    }
    if (process.platform !== "win32") {
      let fifo = true;
      try {
        execFileSync("mkfifo", [path.join(root, "pipe")], { stdio: "ignore" });
      } catch {
        fifo = false;
      }
      if (fifo) assert.strictEqual(await untrackedDiff(root, "pipe", 1024), undefined, "a pipe is never opened (it would wait for a writer)");
    }
    console.log("ok - untracked files: a file's first bytes, a link's target path (never its content), nothing outside the repository");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
