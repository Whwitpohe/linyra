import * as assert from "assert";
import { migratePrivateState, type PrivateState } from "./stateMigration";

class State implements PrivateState {
  constructor(readonly values: Record<string, unknown>, readonly failKey?: string) {}
  keys(): string[] { return Object.keys(this.values); }
  get<T>(key: string): T | undefined { return this.values[key] as T | undefined; }
  async update(key: string, value: unknown): Promise<void> {
    if (key === this.failKey) throw new Error("storage unavailable");
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
  }
}

async function main(): Promise<void> {
  const state = new State({
    "polylog.filter": { branches: ["main"], repoIds: ["acme-api"] },
    "polylog.showChanges": false, "polylog.repoPaneWidth": 0, "polylog.compare.pair": null,
    "polylog.compare.favorites": [], "unrelated.preference": true,
  });
  await migratePrivateState(state);
  assert.deepStrictEqual(state.values, {
    "linyra.filter": { branches: ["main"], repoIds: ["acme-api"] },
    "linyra.showChanges": false, "linyra.repoPaneWidth": 0, "linyra.compare.pair": null,
    "linyra.compare.favorites": [], "unrelated.preference": true,
  });
  await migratePrivateState(state);
  assert.strictEqual(state.keys().length, 6, "running again does not duplicate state");
  console.log("ok - earlier Linyra private state keeps filters, layout and false/null values after migration");

  const current = new State({ "polylog.filter": "old", "linyra.filter": "current" });
  await migratePrivateState(current);
  assert.deepStrictEqual(current.values, { "linyra.filter": "current" });
  console.log("ok - migration preserves newer Linyra preferences and removes retired private keys");

  const failed = new State({ "polylog.filter": "saved" }, "linyra.filter");
  await assert.rejects(migratePrivateState(failed), /storage unavailable/);
  assert.strictEqual(failed.get("polylog.filter"), "saved");
  console.log("ok - a failed write keeps the earlier state available for retry");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
