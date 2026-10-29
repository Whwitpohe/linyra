import * as assert from "assert";
import { authorRows, moveFocus, radiusScale, rowOrder, timeDomain, timeTicks } from "./bubbles";
import { locate, logPathspec, readKey, safePath, sanitizeScope, sinceOf, treePath } from "./range";

// ── Bubble sizes: area grows with lines, capped at the 95th percentile ─────
{
  const lines = [...Array.from({ length: 99 }, (_, i) => i + 1), 1_000_000];
  const r = radiusScale(lines, 3, 12);
  assert.strictEqual(r(0), 3, "a commit with no lines (a rename, a binary) is the smallest bubble");
  assert.strictEqual(r(1_000_000), 12, "the outlier is the biggest, not a hundred times bigger");
  assert.strictEqual(r(96), 12, "the 95th percentile already reaches the top");
  assert.ok(r(10) > r(5) && r(5) > r(1));
  assert.ok(Math.abs((r(24) - 3) / (r(6) - 3) - 2) < 0.2, "four times the lines, twice the radius above the minimum");
  assert.strictEqual(radiusScale([], 3, 12)(5), 12, "no data: any commit fills the scale");
  console.log("ok - bubble radii grow with the square root of lines changed, capped against outliers");
}

// ── Author rows: most commits first, each with their busiest repository ───
{
  const c = (author: string, email: string, repoId: string) => ({ author, email, repoId });
  const rows = authorRows([c("rin", "rin@example.com", "acme-api"), c("dana", "dana@example.com", "acme-web"), c("Dana", "DANA@example.com", "acme-web"),
    c("dana", "dana@example.com", "acme-api"), c("rin", "rin@example.com", "acme-libs"), c("noor", "", "acme-web")]);
  assert.deepStrictEqual(rows.map((r) => [r.name, r.count, r.topRepo]), [["dana", 3, "acme-web"], ["rin", 2, "acme-api"], ["noor", 1, "acme-web"]],
    "one row per email whatever its case; ties broken by repository id");
  assert.strictEqual(rows[2].key, "noor", "no email: the name is the key");
  console.log("ok - Visual History has one row per author, most active first");
}

// ── Time: calendar ticks that fit, a domain with room either side ──────────
{
  const day = 86_400;
  const from = Math.floor(new Date(2026, 6, 15, 13).getTime() / 1000), to = from + 90 * day;
  const ticks = timeTicks(from, to, 840);
  assert.ok(ticks.length >= 3 && ticks.length <= 10, `${ticks.length} ticks fit 840px`);
  assert.ok(ticks.every((t) => t.time >= from && t.time <= to));
  assert.ok(ticks.every((t, i) => i === 0 || t.time > ticks[i - 1].time));
  const units = new Set(ticks.map((t) => t.unit));
  assert.strictEqual(units.size, 1);
  if (ticks[0].unit === "month") assert.ok(ticks.every((t) => new Date(t.time * 1000).getDate() === 1), "months start on the 1st");
  if (ticks[0].unit === "week") assert.ok(ticks.every((t) => new Date(t.time * 1000).getDay() === 1), "weeks start on Monday");
  assert.strictEqual(timeTicks(from, from + 6 * day, 840)[0].unit, "day", "a week is drawn in days");
  assert.strictEqual(timeTicks(from, from + 3650 * day, 840)[0].unit, "year", "ten years in years");
  assert.ok(timeTicks(from, from + 3650 * day, 200).length <= 3, "a narrow axis takes fewer");
  assert.deepStrictEqual(timeTicks(to, from, 800), [], "an empty span");
  const [lo, hi] = timeDomain(from, to, [from + day, to - day]);
  assert.ok(lo < from && hi > to);
  const [allLo] = timeDomain(undefined, to, Array.from({ length: 200_000 }, (_, i) => from + i));
  assert.ok(allLo < from, "all of history starts at the oldest commit; 200,000 commits do not overflow the stack");
  console.log("ok - the time axis ticks in days, weeks, months or years, as many as fit");
}

// ── The keyboard: along a row in time, to the nearest commit above or below ─
{
  // Row 0: commits 0 (t=10), 2 (t=30); row 1: none; row 2: 1 (t=12), 3 (t=40), 4 (t=29).
  const rowOf = [0, 2, 0, 2, 2], times = [10, 12, 30, 40, 29];
  const order = rowOrder(rowOf, times, 3);
  assert.deepStrictEqual(order, [[0, 2], [], [1, 4, 3]]);
  assert.strictEqual(moveFocus(order, times, rowOf, undefined, "ArrowDown"), 2, "from nothing: the top row's newest");
  assert.strictEqual(moveFocus(order, times, rowOf, 2, "ArrowLeft"), 0);
  assert.strictEqual(moveFocus(order, times, rowOf, 0, "ArrowLeft"), 0, "the row's oldest stays");
  assert.strictEqual(moveFocus(order, times, rowOf, 2, "ArrowDown"), 4, "down skips the empty row, to the nearest in time (29 for 30)");
  assert.strictEqual(moveFocus(order, times, rowOf, 1, "ArrowUp"), 0, "up: nearest to 12 is 10");
  assert.strictEqual(moveFocus(order, times, rowOf, 0, "ArrowUp"), 0, "the top row stays");
  assert.strictEqual(moveFocus(order, times, rowOf, 1, "End"), 3);
  assert.strictEqual(moveFocus(order, times, rowOf, 3, "Home"), 1);
  assert.strictEqual(moveFocus([[], []], [], [], undefined, "ArrowRight"), undefined);
  console.log("ok - the keyboard walks a row in time and jumps to the nearest commit on the next row");
}

// ── Ranges and scopes ─────────────────────────────────────────────────────
{
  const now = Date.UTC(2026, 9, 30, 12) / 1000;
  assert.strictEqual(sinceOf("1w", now), now - 7 * 86_400);
  assert.strictEqual(sinceOf("4w", now), now - 28 * 86_400);
  assert.strictEqual(sinceOf("3m", now), Date.UTC(2026, 6, 30, 12) / 1000);
  assert.strictEqual(sinceOf("1y", now), Date.UTC(2025, 9, 30, 12) / 1000);
  assert.strictEqual(sinceOf("all", now), undefined);

  assert.strictEqual(safePath("src\\client.ts"), "src/client.ts");
  assert.strictEqual(safePath("./src/"), "src");
  for (const bad of ["", "/etc/passwd", "../x", "a/../b", "C:/x", ":(glob)*", "a\nb", "a//b", 3]) assert.strictEqual(safePath(bad), undefined, String(bad));
  const known = (id: string) => id === "/work/acme-web";
  assert.deepStrictEqual(sanitizeScope({ kind: "path", repoId: "/work/acme-web", path: "src", folder: true }, known), { kind: "path", repoId: "/work/acme-web", path: "src", folder: true });
  assert.deepStrictEqual(sanitizeScope({ kind: "path", repoId: "/work/acme-web", path: "../x" }, known), { kind: "ticked" });
  assert.deepStrictEqual(sanitizeScope({ kind: "repo", repoId: "/work/gone" }, known), { kind: "ticked" });
  assert.deepStrictEqual(logPathspec({ kind: "path", repoId: "r", path: "src/*.ts", folder: false }), ["--", ":(literal)src/*.ts"]);
  assert.deepStrictEqual(treePath({ kind: "path", repoId: "r", path: "src", folder: true }), ["--", "src"]);
  assert.deepStrictEqual(logPathspec({ kind: "ticked" }), []);

  const repos = [{ root: "C:\\work\\acme-web" }, { root: "C:\\work\\acme-web\\vendor\\acme-libs" }, { root: "C:\\work\\acme-api" }];
  assert.deepStrictEqual(locate(repos, "c:\\WORK\\acme-web\\src\\client.ts", true), { repo: repos[0], path: "src/client.ts" });
  assert.deepStrictEqual(locate(repos, "C:\\work\\acme-web\\vendor\\acme-libs\\index.ts", true), { repo: repos[1], path: "index.ts" }, "the nested repository wins");
  assert.strictEqual(locate(repos, "C:\\work\\acme-webx\\a.ts", true), undefined, "a sibling folder with a longer name is not inside");
  assert.strictEqual(locate(repos, "c:\\work\\acme-web\\a.ts", false), undefined, "case matters where the file system says so");
  assert.deepStrictEqual(locate(repos, "C:\\work\\acme-api", true), { repo: repos[2], path: "" }, "the root itself: the whole repository");

  assert.notStrictEqual(readKey("history", { kind: "ticked" }, "1w", ["a"]), readKey("history", { kind: "ticked" }, "4w", ["a"]));
  assert.strictEqual(readKey("files", { kind: "ticked" }, "1w", ["a"]), readKey("files", { kind: "ticked" }, "4w", ["a"]), "Files does not depend on the range");
  assert.notStrictEqual(readKey("health", { kind: "ticked" }, "1w", ["a"]), readKey("health", { kind: "ticked" }, "1w", ["a", "b"]));
  console.log("ok - ranges count back calendar units; scopes and paths from a webview are checked");
}
