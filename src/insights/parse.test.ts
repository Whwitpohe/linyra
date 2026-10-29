import * as assert from "assert";
import { HEALTH_CONFIG_REGEXP, indexEntries, parseConfig, parseCountObjects, parseHistory, parseTouches, parseTree } from "./parse";

const A = "a".repeat(40), B = "b".repeat(40);

// ── Visual History: one record per commit, its numstat lines summed ─────────
{
  const out = `\x1e${A}\x1f1758000400\x1fdana\x1fdana@example.com\x1ffix: guard nil response\n\n3\t1\tsrc/client.ts\n-\t-\tlogo.png\n10\t0\tdocs/a => b.md\n`
    + `\x1e${B}\x1f1758000100\x1frin\x1frin@example.com\x1fchore: rename only\n`;
  assert.deepStrictEqual(parseHistory(out), [
    { sha: A, time: 1758000400, author: "dana", email: "dana@example.com", subject: "fix: guard nil response", added: 13, deleted: 1, files: 3 },
    { sha: B, time: 1758000100, author: "rin", email: "rin@example.com", subject: "chore: rename only", added: 0, deleted: 0, files: 0 },
  ]);
  assert.strictEqual(parseHistory(`\x1e${A}\x1f1\x1fdana\x1f\x1fa \x1f b\n`)[0].subject, "a \x1f b", "a separator inside the subject stays in it");
  assert.deepStrictEqual(parseHistory(""), []);
  assert.deepStrictEqual(parseHistory(`\x1e${A}\x1f17`), [], "a record cut off by a killed process is dropped");
  console.log("ok - Visual History reads each commit's lines from --numstat (binary files count as files, not lines)");
}

// ── Files: ls-tree -r -l -z, blobs only ───────────────────────────────────
{
  const out = `100644 blob ${A}     812\tsrc/client.ts\x00100755 blob ${B}  1048576\tscripts/build tool.sh\x00160000 commit ${A}       -\tvendor/acme-libs\x00120000 blob ${B}      11\tlink\x00`;
  assert.deepStrictEqual(parseTree(out), [{ path: "src/client.ts", size: 812 }, { path: "scripts/build tool.sh", size: 1048576 }, { path: "link", size: 11 }]);
  assert.deepStrictEqual(parseTree(`100644 blob ${A} 5\tname\twith tab\x00`), [{ path: "name\twith tab", size: 5 }], "-z keeps a tab in a name");
  console.log("ok - Files reads each blob's size from ls-tree; a submodule is skipped");
}

// ── Commits: name-only -z, one count per commit per path ──────────────────
{
  const counts = parseTouches("src/client.ts\x00README.md\x00\x00\nsrc/client.ts\x00src/new\nline.ts\x00");
  assert.deepStrictEqual([...counts], [["src/client.ts", 2], ["README.md", 1], ["src/new\nline.ts", 1]]);
  console.log("ok - Commits counts the commits touching each path");
}

// ── Health: count-objects -v, config --get-regexp, the index header ───────
{
  const objects = parseCountObjects("count: 510\nsize: 2160\nin-pack: 4697\npacks: 4\nsize-pack: 40661\nprune-packable: 510\ngarbage: 1\nsize-garbage: 0\n");
  assert.deepStrictEqual(objects, { loose: 510, looseKiB: 2160, inPack: 4697, packs: 4, packKiB: 40661, prunePackable: 510, garbage: 1 });
  assert.deepStrictEqual(parseCountObjects("warning: garbage found: x\r\n"), { loose: 0, looseKiB: 0, inPack: 0, packs: 0, packKiB: 0, prunePackable: 0, garbage: 0 });

  const config = parseConfig("core.untrackedcache true\ncore.fsmonitor\nmaintenance.repo C:/work/acme-web\nmaintenance.repo /work/acme api\nFeature.ManyFiles \n");
  assert.deepStrictEqual(config.get("core.untrackedcache"), ["true"]);
  assert.deepStrictEqual(config.get("core.fsmonitor"), [null], "a key with no value is a boolean true");
  assert.deepStrictEqual(config.get("maintenance.repo"), ["C:/work/acme-web", "/work/acme api"], "multi-valued, spaces kept");
  assert.deepStrictEqual(config.get("feature.manyfiles"), [""], "an empty value is not the same as no value");
  assert.ok(new RegExp(HEALTH_CONFIG_REGEXP).test("core.untrackedcache") && !new RegExp(HEALTH_CONFIG_REGEXP).test("core.untrackedcachex"));

  const header = (version: number, count: number) => new Uint8Array([0x44, 0x49, 0x52, 0x43, 0, 0, 0, version, (count >>> 24) & 255, (count >>> 16) & 255, (count >>> 8) & 255, count & 255]);
  assert.strictEqual(indexEntries(header(2, 3)), 3);
  assert.strictEqual(indexEntries(header(4, 213_457)), 213_457);
  assert.strictEqual(indexEntries(header(4, 0xfffffffe)), 0xfffffffe, "unsigned");
  assert.strictEqual(indexEntries(header(5, 3)), undefined, "an unknown version");
  assert.strictEqual(indexEntries(header(2, 3), true), undefined, "a split index's own count is partial");
  assert.strictEqual(indexEntries(new Uint8Array([1, 2, 3])), undefined);
  console.log("ok - Health parses count-objects, every scope's config, and the index header's entry count");
}
