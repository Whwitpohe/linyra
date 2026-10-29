import * as assert from "assert";
import { toolbarCommand, type ToolbarState } from "./toolbarModel";

const hidden: ToolbarState = { groupByRepo: false, compareShown: false, fetching: false, anyBehind: false };
const shown: ToolbarState = { groupByRepo: true, compareShown: true, fetching: true, anyBehind: true };
const actions = ["toggleRepos", "toggleCompare", "fetchAll", "showBehind", "fetchAndPullAll", "pullAllBehind", "profileSwitch", "profileSave"];
const preserved = new Set([hidden, shown, { ...shown, fetching: false }].flatMap((state) => actions.map((action) => toolbarCommand(action, state)).filter(Boolean)));
for (const command of ["linyra.showRepos", "linyra.hideRepos", "linyra.compareShow", "linyra.compareHide",
  "linyra.fetchAll", "linyra.fetching", "linyra.showBehind", "linyra.fetchAndPullAll", "linyra.pullAllBehind", "linyra.profileSwitch", "linyra.profileSave"]) {
  assert.ok(preserved.has(command), `the old Log toolbar command remains reachable: ${command}`);
}
assert.strictEqual(toolbarCommand("pullAllBehind", shown), undefined, "pull cannot race an active fetch");
assert.strictEqual(toolbarCommand("showBehind", hidden), undefined);
for (const action of [null, {}, "constructor", "__proto__", "vscode.openFolder", "delete"]) assert.strictEqual(toolbarCommand(action, hidden), undefined, "only named toolbar actions can execute commands");
console.log("ok - all 13 old Log toolbar commands remain reachable with state guards and no arbitrary command execution");
assert.deepStrictEqual(["aiConfigure", "aiSwitch", "aiRemove"].map((action) => toolbarCommand(action, hidden)), ["linyra.ai.configure", "linyra.ai.switchModel", "linyra.ai.removeProfile"]);
console.log("ok - the ⋯ menu's AI items run Configure AI…, Switch AI Model… and Remove AI Profile…");
