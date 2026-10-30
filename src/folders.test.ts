import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sameFolder, samePath } from "./folders";

void (async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "linyra-folders-"));
  try {
    const repo = path.join(home, "acme-web");
    fs.mkdirSync(repo);
    // Another name for the same folder: a junction on Windows (no privilege needed), a symlink elsewhere.
    const link = path.join(home, "acme-web-link");
    fs.symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");

    assert.ok(samePath(repo, `${repo}${path.sep}`), "a trailing separator");
    assert.strictEqual(samePath(repo.toUpperCase(), repo), process.platform === "win32" || process.platform === "darwin", "case, where the file system ignores it");
    assert.ok(!samePath(link, repo), "spelled differently");
    assert.ok(await sameFolder(link, repo), "the same folder by another name");
    assert.ok(await sameFolder(repo, link));
    assert.ok(await sameFolder(repo, repo));
    assert.ok(!(await sameFolder(repo, home)), "another folder");
    assert.ok(!(await sameFolder(path.join(home, "gone"), repo)), "a folder that is gone is compared as written");
    console.log("ok - the same folder however it is reached: spelling, case, a symlink or junction; a gone one as written");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
