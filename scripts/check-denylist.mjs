// Fails when any denylisted entry appears in tracked (or new, unignored) files,
// in file names, or in commit authors/committers/messages. With --dir <path>
// it scans a directory instead — CI uses that on the unpacked VSIX, so what
// ships is checked, not just the source it was built from.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { findHits, parsePatterns } from "./denylist.mjs";

const source =
  process.env.LINYRA_DENYLIST || (existsSync(".denylist") ? readFileSync(".denylist", "utf8") : "");
const patterns = parsePatterns(source);
if (patterns.length === 0) {
  console.error(
    "denylist: no entries. Set the LINYRA_DENYLIST secret in CI, or create .denylist locally " +
      "(one entry per line). Refusing to pass with an empty list.",
  );
  process.exit(1);
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

const targets = []; // { name, text }
const dirFlag = process.argv.indexOf("--dir");
if (dirFlag !== -1) {
  const root = process.argv[dirFlag + 1];
  for (const file of walk(root)) targets.push({ name: relative(root, file), text: readFileSync(file, "utf8") });
} else {
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    if (existsSync(file) && statSync(file).isFile()) targets.push({ name: file, text: readFileSync(file, "utf8") });
  }
  const history = execFileSync("git", ["log", "--all", "--format=%an%n%ae%n%cn%n%ce%n%B"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  targets.push({ name: "(git history: authors, committers, messages)", text: history });
}

let failures = 0;
for (const { name, text } of targets) {
  for (const { entry } of findHits(name, patterns)) {
    console.error(`${name}: file name matches denylist entry #${entry}`);
    failures++;
  }
  for (const { line, entry } of findHits(text, patterns)) {
    console.error(`${name}:${line}: matches denylist entry #${entry}`);
    failures++;
  }
}
if (failures > 0) {
  console.error(`denylist: ${failures} hit(s). Replace with neutral placeholders (acme-web, acme-api, acme-libs, dana, rin).`);
  process.exit(1);
}
console.log(`denylist: ${patterns.length} entries, ${targets.length} targets clean`);
