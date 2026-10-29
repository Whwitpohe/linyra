import * as assert from "assert";
import { MessageRoutes } from "./messageRoutes";

void (async () => {
  const seen: string[] = [];
  const routes = new MessageRoutes()
    .on("hoverEnd", () => { seen.push("hoverEnd"); })
    .on("hover", async (m) => { await Promise.resolve(); seen.push(`hover ${String(m.sha)}`); })
    .onReady({ before: () => seen.push("before 1"), after: async () => { await Promise.resolve(); seen.push("after 1"); } })
    .onReady({ after: () => seen.push("after 2") });
  assert.strictEqual(await routes.dispatch({ type: "hover", repoId: "/w/acme-web", sha: "abc" }), true);
  assert.strictEqual(await routes.dispatch({ type: "hoverEnd" }), true);
  assert.strictEqual(await routes.dispatch({ type: "refresh" }), false, "a message no feature owns is logView's");
  await routes.ready("before");
  await routes.ready("after");
  assert.deepStrictEqual(seen, ["hover abc", "hoverEnd", "before 1", "after 1", "after 2"], "handlers awaited; hooks in order, each phase apart");
  assert.throws(() => routes.on("hover", () => undefined), /Two handlers for the "hover" message/);
  console.log("ok - each message to its feature, awaited; ready hooks before and after the first page, in order");
})().catch((e) => { console.error(e); process.exit(1); });
