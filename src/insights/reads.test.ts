import * as assert from "assert";
import { TabReads } from "./reads";

/** A read per repository that resolves when the test says, and counts the processes it stands for. */
function reads() {
  const started: string[] = [];
  const pending = new Map<string, { resolve(v: string): void; reject(e: unknown): void }[]>();
  const read = (repo: { id: string }, signal: AbortSignal) => new Promise<string>((resolve, reject) => {
    started.push(repo.id);
    const list = pending.get(repo.id) ?? [];
    const entry = { resolve, reject };
    list.push(entry);
    pending.set(repo.id, list);
    // A killed process answers nothing more.
    signal.addEventListener("abort", () => {
      list.splice(list.indexOf(entry), 1);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
  const land = async (id: string, value = `${id}@v${started.filter((s) => s === id).length}`) => {
    const list = pending.get(id);
    list?.shift()?.resolve(value);
    await tick();
  };
  return { started, read, land };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const repos = (...ids: string[]) => ids.map((id) => ({ id }));
// A promise that never settles ends the process quietly: that is a failure, not a pass.
let finished = false;
process.on("exit", () => {
  if (!finished) { console.error("not ok - a read never settled"); process.exitCode = 1; }
});

(async () => {
  // ── One process per repository; a second request for what is there reads nothing ──
  {
    const t = new TabReads<string>(() => 100);
    const r = reads();
    const req = t.begin();
    const answer = t.for("k");
    const done = t.fill(req, answer, repos("a", "b"), 4, r.read);
    await r.land("a");
    await r.land("b");
    assert.strictEqual(await done, true);
    assert.deepStrictEqual([...answer.byRepo].map(([id, v]) => [id, v.value]), [["a", "a@v1"], ["b", "b@v1"]]);
    assert.strictEqual(await t.fill(t.begin(), t.for("k"), repos("a"), 4, r.read), true, "a subset: nothing missing");
    assert.deepStrictEqual(r.started, ["a", "b"]);
    console.log("ok - a tab reads each repository once per key, and a subset of what it read reads nothing");
  }

  // ── A newer request wins: the older one does not post over it ─────────────
  {
    const t = new TabReads<string>();
    const r = reads();
    const older = t.begin();
    const first = t.fill(older, t.for("k"), repos("a", "c"), 4, r.read);
    // Scope narrowed to "a" while c is still read: a's answer is already there? not yet; the newer waits for the same read.
    await r.land("a");
    const newer = t.begin();
    const second = t.fill(newer, t.for("k"), repos("a"), 4, r.read);
    await r.land("c");
    assert.strictEqual(await first, false, "the older request is not the latest: it must not post");
    assert.strictEqual(await second, true);
    assert.deepStrictEqual(r.started, ["a", "c"], "the newer one waited for the read of the same answer, reading nothing twice");
    console.log("ok - an older request never posts over a newer one; a read of the same answer is shared, not repeated");
  }

  // ── A key change stops the old read; its late answers are not stored ─────
  {
    const t = new TabReads<string>();
    const r = reads();
    const old = t.fill(t.begin(), t.for("1w"), repos("a"), 4, r.read);
    const fresh = t.for("all");
    const now = t.fill(t.begin(), fresh, repos("a"), 4, r.read);
    assert.strictEqual(await old, false);
    await r.land("a");
    assert.strictEqual(await now, true);
    assert.strictEqual(fresh.byRepo.get("a")?.value, "a@v2");
    console.log("ok - a new range or scope path stops the old read");
  }

  // ── Refs moving during a read: that repository's result is not kept, and is read again ──
  {
    const t = new TabReads<string>();
    const r = reads();
    const answer = t.for("k");
    const done = t.fill(t.begin(), answer, repos("a", "b"), 4, r.read);
    t.stale("a");
    await r.land("a", "old-a");
    await r.land("b");
    await tick();
    assert.strictEqual(answer.byRepo.has("a"), false, "the read that started before the refs moved is not stored");
    await r.land("a", "new-a");
    assert.strictEqual(await done, true);
    assert.strictEqual(answer.byRepo.get("a")?.value, "new-a");
    assert.deepStrictEqual(r.started, ["a", "b", "a"], "only the stale repository is read again");
    t.stale(undefined);
    assert.strictEqual(answer.byRepo.size, 0, "Fetch All: every repository");
    console.log("ok - a repository whose refs moved during its read is read again, alone");
  }

  // ── Stopping keeps what arrived; an error is an answer; Refresh starts over ──
  {
    const t = new TabReads<string>();
    const r = reads();
    const answer = t.for("k");
    const done = t.fill(t.begin(), answer, repos("a", "b"), 4, r.read);
    await r.land("a");
    t.stop();
    assert.strictEqual(await done, false, "stopped: not complete, not posted");
    assert.deepStrictEqual([...answer.byRepo.keys()], ["a"], "a, which arrived, stays");
    assert.strictEqual(t.reading, false);
    const again = t.fill(t.begin(), answer, repos("a", "b"), 4, async () => { throw new Error("fatal: bad object HEAD"); });
    assert.strictEqual(await again, true);
    assert.strictEqual(answer.byRepo.get("b")?.error, "fatal: bad object HEAD");
    const v = answer.version;
    t.forget();
    assert.strictEqual(t.answer, undefined);
    assert.notStrictEqual(t.for("k"), answer, "Refresh: a fresh answer, a new clock");
    assert.ok(v > 0);
    console.log("ok - stopping keeps what arrived; a failure is stored as the answer; Refresh starts over");
  }
  finished = true;
})().catch((e) => { console.error(e); process.exit(1); });
