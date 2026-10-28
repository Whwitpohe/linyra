import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { SCHEME } from "./revisionUri";

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.strictEqual(`${manifest.publisher}.${manifest.name}`, "whwitpohe.linyra");
assert.strictEqual(SCHEME, "linyra");
for (const { command } of manifest.contributes.commands) assert.ok(command.startsWith("linyra."), command);
for (const key of Object.keys(manifest.contributes.configuration.properties)) assert.ok(key.startsWith("linyra."), key);
for (const containers of Object.values(manifest.contributes.viewsContainers) as { id: string }[][]) {
  for (const { id } of containers) assert.ok(id === "linyra" || id.startsWith("linyra-"), id);
}
for (const [container, views] of Object.entries(manifest.contributes.views) as [string, { id: string }[]][]) {
  assert.ok(container === "linyra" || container.startsWith("linyra-"), container);
  for (const { id } of views) assert.ok(id.startsWith("linyra."), id);
}
assert.ok(!JSON.stringify(manifest).toLowerCase().includes("polylog"), "manifest must not claim upstream commands, views, menus or activation events");
assert.ok(fs.existsSync(path.join(root, "media/linyra.svg")));
console.log("ok - Linyra settings, commands, views, activation events and revision scheme use independent identifiers");

for (const file of ["package.nls.json", "package.nls.zh-cn.json"]) {
  const catalog = fs.readFileSync(path.join(root, file), "utf8");
  assert.ok(!catalog.toLowerCase().includes("polylog"), `${file} contains a retired identifier`);
}
console.log("ok - both native translation catalogs use the Linyra identity");
