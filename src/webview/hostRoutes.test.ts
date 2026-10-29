import * as assert from "assert";
import { HostRoutes } from "./hostRoutes";

{
  const seen: string[] = [];
  const routes = new HostRoutes()
    .on("hoverDetail", (m) => seen.push(`hover ${m.sha}`))
    .on("focusChanges", () => seen.push("focus"));
  assert.strictEqual(routes.dispatch({ type: "focusChanges" }), true);
  assert.strictEqual(routes.dispatch({ type: "hoverDetail", repoId: "/w/acme-web", sha: "abc" } as never), true);
  assert.strictEqual(routes.dispatch({ type: "loading" }), false, "a message no part owns is main.ts's");
  assert.deepStrictEqual(seen, ["focus", "hover abc"]);
  assert.throws(() => routes.on("focusChanges", () => undefined), /Two handlers for the "focusChanges" message/);
  console.log("ok - the host's messages, each to the part of the page that owns it");
}
