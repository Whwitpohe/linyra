import * as assert from "assert";
import type { Memento } from "vscode";
import { sessionMemento, withSessionState } from "./sessionMemento";

/**
 * VS Code's globalState as its extension host keeps it: one object, written whole after an update,
 * and replaced by whatever the main process answers. `echo` delivers one answer (the object as it
 * was when that write went out), as late as the IPC makes it.
 */
function hostMemento() {
  let value: Record<string, unknown> = {};
  const answers: Record<string, unknown>[] = [];
  const m: Memento & { setKeysForSync(keys: readonly string[]): void; synced: readonly string[] } = {
    synced: [],
    keys: () => Object.keys(value).filter((k) => value[k] !== undefined),
    get: <T>(key: string, fallback?: T) => (value[key] === undefined ? fallback : (value[key] as T)),
    update: (key: string, v: unknown) => { value = { ...value, [key]: v }; answers.push({ ...value }); return Promise.resolve(); },
    setKeysForSync(keys: readonly string[]) { this.synced = keys; },
  };
  return { m, echo: () => { value = answers.shift() ?? value; } };
}

{
  // The race itself: a pane's width saved, then Include new files switched off before the main
  // process answered the first write. Its answer puts "on" back in VS Code's own copy.
  const host = hostMemento();
  void host.m.update("linyra.stash.untracked", true);
  host.echo();
  void host.m.update("linyra.layout", { repoPane: 300 });
  void host.m.update("linyra.stash.untracked", false);
  host.echo();
  assert.strictEqual(host.m.get("linyra.stash.untracked"), true, "VS Code's own copy: the older answer won");

  const raced = hostMemento(), state = sessionMemento(raced.m);
  void state.update("linyra.stash.untracked", true);
  raced.echo();
  void state.update("linyra.layout", { repoPane: 300 });
  void state.update("linyra.stash.untracked", false);
  raced.echo();
  assert.strictEqual(state.get("linyra.stash.untracked"), false, "this session's last write is what it reads");
  assert.deepStrictEqual(state.get("linyra.layout"), { repoPane: 300 });
  console.log("ok - globalState reads back this session's writes, though VS Code's answer to an earlier one arrives after them");
}

{
  const host = hostMemento();
  void host.m.update("before", "kept");
  const state = sessionMemento(host.m);
  assert.strictEqual(state.get("before"), "kept", "what earlier sessions saved is read from VS Code");
  assert.strictEqual(state.get("missing", 7), 7);
  assert.strictEqual(state.get("missing"), undefined);
  void state.update("before", undefined);
  assert.strictEqual(state.get("before", "fallback"), "fallback", "undefined removes the key: the default answers");
  assert.deepStrictEqual(state.keys(), [], "and it is not a key any more");
  void state.update("on", false);
  assert.strictEqual(state.get("on", true), false, "false is a value, not a missing key");
  const object = { width: 300 };
  void state.update("pane", object);
  object.width = 10;
  assert.deepStrictEqual(state.get("pane"), { width: 300 }, "the value as saved, not the caller's object changed later");
  assert.deepStrictEqual([...state.keys()].sort(), ["on", "pane"]);
  state.setKeysForSync(["on"]);
  assert.deepStrictEqual(host.m.synced, ["on"], "setKeysForSync is VS Code's own");
  console.log("ok - defaults, removal, false and objects read as VS Code's Memento reads them");
}

{
  // VS Code's context is frozen: the session's globalState over it, every other member its own.
  const host = hostMemento();
  const subscriptions: { dispose(): void }[] = [];
  const context = Object.freeze({ globalState: host.m, subscriptions, get extensionPath() { return "/ext"; } });
  const ours = withSessionState(context);
  assert.notStrictEqual(ours.globalState, host.m);
  assert.strictEqual(ours.subscriptions, subscriptions, "subscriptions pushed on it are the context's own");
  assert.strictEqual(ours.extensionPath, "/ext");
  void ours.globalState.update("k", 1);
  assert.strictEqual(host.m.get("k"), 1, "writes reach VS Code");
  console.log("ok - the extension's context keeps every member, globalState read as this session wrote it");
}
