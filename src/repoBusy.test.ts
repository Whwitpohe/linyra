import * as assert from "assert";
import { RepoBusy } from "./repoBusy";

{
  const busy = new RepoBusy();
  const reset = busy.take("/ws/acme-web");
  assert.ok(reset && busy.has("/ws/acme-web"));
  assert.strictEqual(busy.take("/ws/acme-web"), undefined, "a second write in the same repository waits for nothing and does nothing");
  // Update Project across three: the one a Reset holds is left out, the others are held.
  const update = busy.takeEach(["/ws/acme-web", "/ws/acme-api", "/ws/acme-libs", "/ws/acme-api"]);
  assert.deepStrictEqual([update.taken, update.busy], [["/ws/acme-api", "/ws/acme-libs"], ["/ws/acme-web"]]);
  reset!();
  reset!();
  assert.ok(!busy.has("/ws/acme-web"), "released");
  assert.ok(busy.has("/ws/acme-api"), "releasing twice releases nothing else");
  update.release();
  assert.ok(!busy.has("/ws/acme-api") && !busy.has("/ws/acme-libs"));
  assert.ok(busy.take("/ws/acme-api"), "free again");
  console.log("ok - one write per repository at a time, shared by every module that writes");
}
