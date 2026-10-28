import * as assert from "assert";
import { DEFAULT_FILTER, type FilterState } from "../filterModel";
import {
  absoluteTime, accentOf, ACCENT_COUNT, assignAccents, chipsThatFit, fitMiddle, middleTruncate, repoColumnChars, branchUseLabel, countLabel, dateLabel, emptyState, moveSelection,
  relativeTime, repoButtonLabel, reselect, separateAdjacentAccents, splitPath, visibleRange, switchCount, totalsLabel, meterParts, escapeTarget,
} from "./view";

const NOW = 1790164800;
const ALL: FilterState = { ...DEFAULT_FILTER, date: "all" };
const repos = ["acme-web", "acme-api", "acme-libs"].map((n) => ({ id: `/ws/${n}`, name: n }));

{
  assert.strictEqual(relativeTime(NOW, NOW - 5), "just now");
  assert.strictEqual(relativeTime(NOW, NOW + 3600), "just now", "clock skew never shows negative");
  assert.strictEqual(relativeTime(NOW, NOW - 5 * 60), "5m ago");
  assert.strictEqual(relativeTime(NOW, NOW - 2 * 3600), "2h ago");
  assert.strictEqual(relativeTime(NOW, NOW - 86_400), "1d ago");
  assert.strictEqual(relativeTime(NOW, NOW - 45 * 86_400), "1mo ago");
  assert.strictEqual(relativeTime(NOW, NOW - 800 * 86_400), "2y ago");
  assert.match(absoluteTime(NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  console.log("ok - relative and absolute time labels");
}
{
  assert.deepStrictEqual(visibleRange(0, 400, 40, 1000, 8), { start: 0, end: 18 });
  assert.deepStrictEqual(visibleRange(4000, 400, 40, 1000, 8), { start: 92, end: 118 });
  assert.deepStrictEqual(visibleRange(39_900, 400, 40, 1000, 8), { start: 989, end: 1000 });
  assert.deepStrictEqual(visibleRange(0, 400, 40, 0), { start: 0, end: 0 });
  console.log("ok - visibleRange renders only the window plus overscan");
}
{
  assert.strictEqual(moveSelection("ArrowDown", -1, 10, 5), 0);
  assert.strictEqual(moveSelection("ArrowDown", 9, 10, 5), 9);
  assert.strictEqual(moveSelection("ArrowUp", 0, 10, 5), 0);
  assert.strictEqual(moveSelection("ArrowUp", -1, 10, 5), 0);
  assert.strictEqual(moveSelection("Home", 7, 10, 5), 0);
  assert.strictEqual(moveSelection("End", 2, 10, 5), 9);
  assert.strictEqual(moveSelection("PageDown", 2, 10, 5), 7);
  assert.strictEqual(moveSelection("PageUp", 2, 10, 5), 0);
  assert.strictEqual(moveSelection("a", 2, 10, 5), null);
  assert.strictEqual(moveSelection("ArrowDown", -1, 0, 5), null);
  console.log("ok - keyboard selection clamps to the list");
}
{
  const repo = (name: string) => ({ id: `/ws/${name}`, name });
  const six = ["acme-api", "acme-docs", "acme-infra", "acme-libs", "acme-mobile", "acme-web"].map(repo);
  const a = assignAccents(six);
  assert.strictEqual(ACCENT_COUNT, 6);
  assert.strictEqual(new Set(six.map((r) => a.get(r.id))).size, 6, "six repositories get six different hues");
  assert.deepStrictEqual(assignAccents([...six].reverse()), a, "the order repositories were discovered in does not matter");
  const withLast = assignAccents([...six, repo("acme-zeta")]);
  assert.ok(six.every((r) => withLast.get(r.id) === a.get(r.id)), "a repository that sorts last moves nobody");
  // Honest limit (spec §18): one that sorts early can move repos after it in name order.
  const many = Array.from({ length: 20 }, (_, i) => repo(`svc-${i}`));
  const m = assignAccents(many);
  const counts = new Map<number, number>();
  for (const r of many) counts.set(m.get(r.id)!, (counts.get(m.get(r.id)!) ?? 0) + 1);
  assert.ok(Math.max(...counts.values()) - Math.min(...counts.values()) <= 1, "past six, hues are shared evenly");
  assert.strictEqual(accentOf(a, "/ws/unknown"), 0, "a repository outside the list still renders");
  console.log("ok - each repo keeps one hue: from its name, distinct up to six, the same under any filter");
}
{
  const preferred = new Map([["acme-api", 4], ["acme-libs", 4], ["acme-web", 2]]);
  const rows = ["acme-api", "acme-api", "acme-libs", "acme-web", "acme-api", "acme-libs"].map((repoId) => ({ repoId }));
  const colors = separateAdjacentAccents(rows, preferred);
  assert.notStrictEqual(colors.get("acme-api"), colors.get("acme-libs"), "different neighboring repositories must be distinguishable");
  assert.strictEqual(colors.get("acme-api"), preferred.get("acme-api"), "prefer preserving the preceding repository's hue");
  assert.strictEqual(colors.get("acme-web"), preferred.get("acme-web"), "unaffected repository hues stay unchanged");
  assert.strictEqual(preferred.get("acme-libs"), 4, "the baseline palette is not mutated");
  assert.strictEqual(separateAdjacentAccents(rows, colors), colors, "refreshing the same log keeps the palette and its identity");
  assert.strictEqual(separateAdjacentAccents(rows.filter((row) => row.repoId !== "acme-web"), colors), colors, "removing a repository does not undo existing repairs");
  assert.strictEqual(separateAdjacentAccents([], colors), colors);
  console.log("ok - adjacent repository bands differ while repeated repos and unaffected hues stay consistent");
}
{
  const preferred = new Map([["acme-api", 0], ["acme-libs", 1], ["acme-web", 0]]);
  const rows = ["acme-api", "acme-libs", "acme-web"].map((repoId) => ({ repoId }));
  assert.strictEqual(separateAdjacentAccents(rows, preferred), preferred, "nonadjacent repos may reuse a theme hue");
  const folded = separateAdjacentAccents([rows[0], rows[2]], preferred);
  assert.notStrictEqual(folded.get("acme-api"), folded.get("acme-web"), "folding can expose a new adjacent collision");
  const appended = separateAdjacentAccents([...rows, rows[0]], preferred);
  assert.notStrictEqual(appended.get("acme-api"), appended.get("acme-web"), "a newly appended page is checked too");
  console.log("ok - folding and pagination repair newly adjacent bands without recoloring already distinct ones");
}
{
  const ids = Array.from({ length: 24 }, (_, i) => `acme-service-${i}`);
  const preferred = new Map(ids.map((id, i) => [id, i % ACCENT_COUNT]));
  const order = Array.from({ length: ACCENT_COUNT }, (_, hue) => ids.filter((_, i) => i % ACCENT_COUNT === hue)).flat();
  const rows = [...order, ...order].map((repoId) => ({ repoId }));
  const colors = separateAdjacentAccents(rows, preferred);
  for (let i = 1; i < rows.length; i++) assert.notStrictEqual(colors.get(rows[i - 1].repoId), colors.get(rows[i].repoId));
  assert.ok([...colors.values()].every((hue) => hue >= 0 && hue < ACCENT_COUNT));
  console.log("ok - more repositories than theme hues still get distinct adjacent bands");
}
{
  const left = Array.from({ length: ACCENT_COUNT }, (_, i) => `acme-api-${i}`);
  const right = Array.from({ length: ACCENT_COUNT }, (_, i) => `acme-web-${i}`);
  const preferred = new Map([...left, ...right].map((id, i) => [id, i % ACCENT_COUNT]));
  const rows = left.flatMap((a) => right.flatMap((b) => [a, b, a])).map((repoId) => ({ repoId }));
  const colors = separateAdjacentAccents(rows, preferred);
  for (let i = 1; i < rows.length; i++) if (rows[i - 1].repoId !== rows[i].repoId) {
    assert.notStrictEqual(colors.get(rows[i - 1].repoId), colors.get(rows[i].repoId));
  }
  console.log("ok - crowded neighborhoods can move several hues together instead of leaving avoidable collisions");
}
{
  assert.strictEqual(repoButtonLabel(null, repos), "All repositories");
  assert.strictEqual(repoButtonLabel([], repos), "No repositories");
  assert.strictEqual(repoButtonLabel(["/ws/acme-api"], repos), "acme-api");
  assert.strictEqual(repoButtonLabel(["/ws/acme-api", "/ws/acme-web"], repos), "2 of 3 repositories");
  console.log("ok - repo picker label");
}
{
  assert.strictEqual(dateLabel(ALL), "");
  assert.strictEqual(dateLabel({ ...ALL, date: "24h" }), " in the last 24 hours");
  assert.strictEqual(dateLabel({ ...ALL, date: "custom", from: "2026-09-01", to: "2026-09-10" }), " between 2026-09-01 and 2026-09-10");
  assert.strictEqual(dateLabel({ ...ALL, date: "custom", from: "2026-09-01" }), " since 2026-09-01");
  assert.strictEqual(dateLabel({ ...ALL, date: "custom" }), "");
  console.log("ok - date labels read as sentence fragments");
}
{
  assert.deepStrictEqual(emptyState({ repoCount: 0, filter: ALL }).action, { label: "Open Settings", id: "settings" });
  assert.match(emptyState({ repoCount: 0, filter: ALL }).body, /git\.repositoryScanMaxDepth/);
  assert.match(emptyState({ repoCount: 0, filter: ALL }).body, /linyra\.scanDepth/);
  assert.deepStrictEqual(emptyState({ repoCount: 3, filter: { ...ALL, repoIds: [] } }).action?.id, "selectAll");
  const text = emptyState({ repoCount: 3, filter: { ...DEFAULT_FILTER, text: "ACME-7" } });
  assert.strictEqual(text.body, "No commit message contains “ACME-7” in 3 repositories in the last 24 hours.");
  assert.strictEqual(text.action?.id, "clearText");
  const date = emptyState({ repoCount: 1, filter: { ...ALL, date: "24h" } });
  assert.strictEqual(date.body, "No commits in 1 repository in the last 24 hours.");
  assert.strictEqual(date.action?.id, "allTime");
  assert.strictEqual(emptyState({ repoCount: 3, filter: { ...ALL, repoIds: ["/ws/acme-api"] } }).action?.id, "selectAll");
  const none = emptyState({ repoCount: 3, filter: ALL });
  assert.match(none.body, /one merged log/);
  assert.match(none.body, /found 3 repositories/);
  assert.strictEqual(none.action, undefined);
  console.log("ok - each empty state names its cause and offers the matching fix");
}
{
  assert.strictEqual(countLabel(1), "1 commit");
  assert.strictEqual(countLabel(214), "214 commits");
  assert.deepStrictEqual(splitPath("internal/upload/upload.go"), { dir: "internal/upload", base: "upload.go" });
  assert.deepStrictEqual(splitPath("README.md"), { dir: "", base: "README.md" });
  console.log("ok - count label and path split");
}
{
  const rows = ["a", "b", "c"].map((sha) => ({ repoId: "/ws/acme-web", sha }));
  assert.strictEqual(reselect("/ws/acme-web\0b", rows), 1, "a replayed or refreshed page keeps the selected commit");
  assert.strictEqual(reselect("/ws/acme-web\0gone", rows), 0, "a commit no longer listed falls back to the first row");
  assert.strictEqual(reselect(null, rows), 0);
  assert.strictEqual(reselect("/ws/acme-web\0a", []), -1, "no rows, no selection");
  console.log("ok - reselect keeps the selection across a replay or refresh");
}
{
  const by = emptyState({ repoCount: 3, filter: { ...ALL, author: "rin" } });
  assert.strictEqual(by.body, "No commits by “rin” in 3 repositories.");
  assert.deepStrictEqual(by.action, { label: "Clear Author", id: "clearAuthor" });
  const both = emptyState({ repoCount: 3, filter: { ...DEFAULT_FILTER, text: "ACME-7", author: "dana" } });
  assert.strictEqual(both.body, "No commit by “dana” contains “ACME-7” in 3 repositories in the last 24 hours.");
  assert.strictEqual(both.action?.id, "clearText");
  console.log("ok - empty states name the author filter and offer to clear it");
}
{
  const h = emptyState({ repoCount: 3, filter: DEFAULT_FILTER, history: "src/client.ts" });
  assert.strictEqual(h.body, "No commits to src/client.ts in the last 24 hours.");
  assert.strictEqual(h.action?.id, "allTime");
  assert.strictEqual(emptyState({ repoCount: 3, filter: { ...ALL, text: "zzz" }, history: "a.ts" }).body, "No commit to a.ts contains “zzz”.");
  console.log("ok - file history has its own empty state");
}
{
  assert.strictEqual(branchUseLabel({ branches: ["origin/prod"], found: 52, missing: 16 }), "origin/prod in 52 repos · skipped 16 without selected branches");
  assert.strictEqual(branchUseLabel({ branches: ["origin/prod"], found: 3, missing: 0 }), "origin/prod in all 3 repos");
  assert.strictEqual(branchUseLabel({ branches: ["prod", "main"], found: 0, missing: 2 }), "2 branches in 0 repos · skipped 2 without selected branches");
  assert.strictEqual(branchUseLabel(undefined), "");
  console.log("ok - the footer says which repos use the branch and which fell back");
}
{
  assert.strictEqual(middleTruncate("acme-web", 12), "acme-web", "short names are untouched");
  assert.strictEqual(middleTruncate("acme-mobile-shipper-ops", 16), "acme-mob…per-ops", "long names keep their start and their end");
  assert.strictEqual(middleTruncate("acme-mobile-shipper-ops", 16).length, 16);
  assert.notStrictEqual(middleTruncate("acme-mobile-shipper-ops", 16), middleTruncate("acme-mobile-shipper-app", 16), "names that share a start stay apart");
  assert.strictEqual(middleTruncate("abcdef", 1), "…");
  assert.strictEqual(middleTruncate("😀😀😀😀😀", 3), "😀…😀", "never splits a character made of two UTF-16 units");
  console.log("ok - long repo names are cut in the middle, so the part that tells them apart stays");
}
{
  assert.strictEqual(repoColumnChars(["acme-web", "acme-api"]), 10, "never narrower than 10 characters");
  assert.strictEqual(repoColumnChars(["acme-web", "acme-mobile-shipper"]), 19, "fits the longest name");
  assert.strictEqual(repoColumnChars(["a".repeat(60)]), 28, "and stops at 28");
  assert.strictEqual(repoColumnChars([]), 10);
  console.log("ok - the repo column fits the workspace's longest repo name, within limits");
}
{
  // A fake measure: 7px per character.
  const within = (px: number) => (t: string) => t.length * 7 <= px;
  assert.strictEqual(fitMiddle("acme-mobile-shipper-ops", within(1000)), "acme-mobile-shipper-ops", "a name that fits is untouched");
  const cut = fitMiddle("acme-mobile-shipper-ops", within(112));
  assert.strictEqual(cut, "acme-mob…per-ops", "otherwise the longest middle cut that fits (16 × 7 = 112px)");
  assert.notStrictEqual(cut, fitMiddle("acme-mobile-shipper-app", within(112)), "so similar names stay apart at any width");
  assert.strictEqual(fitMiddle("acme-web", within(3)), "…", "no room at all still renders");
  console.log("ok - a repo name is cut in the middle to exactly what fits the space it has");
}
{
  const by = (f: Partial<FilterState>) => emptyState({ repoCount: 3, filter: { ...ALL, ...f } }).body;
  assert.match(by({ authors: ["dana", "rin"] }), /No commits by “dana” or “rin” in /, "two chips");
  assert.match(by({ authors: ["dana"], author: "rin", mine: true }), /No commits by “dana”, “rin” or you in /, "chips, typed text and Me");
  assert.deepStrictEqual(emptyState({ repoCount: 3, filter: { ...ALL, authors: ["dana"] } }).action, { label: "Clear Author", id: "clearAuthor" });
  console.log("ok - the empty state names every author being filtered on");
}
{
  const e = emptyState({ repoCount: 3, filter: { ...ALL, path: "src/checkout" } });
  assert.match(e.body, /No commit touches “src\/checkout” in 3 repositories/);
  assert.deepStrictEqual(e.action, { label: "Clear Path", id: "clearPath" });
  assert.match(emptyState({ repoCount: 3, filter: { ...ALL, path: "src", text: "fix" } }).body, /No commit touching “src” contains “fix”/, "path and search together");
  console.log("ok - the empty state names the path and offers to clear it");
}
{
  // Chip widths 50, 60, 70; a "+N" chip is 30 wide; gaps are 3.
  assert.strictEqual(chipsThatFit([50, 60, 70], 500, 30, 3), 3, "room for all: no +N");
  assert.strictEqual(chipsThatFit([50, 60, 70], 150, 30, 3), 2, "50+3+60 = 113, and 113+3+30 = 146 fits with the +1 chip");
  assert.strictEqual(chipsThatFit([50, 60, 70], 100, 30, 3), 1, "only one, then +2");
  assert.strictEqual(chipsThatFit([50, 60, 70], 20, 30, 3), 0, "no room: everything behind +3");
  assert.strictEqual(chipsThatFit([], 100, 30, 3), 0);
  console.log("ok - author chips keep their width; the ones that do not fit collapse into +N");
}
{
  assert.strictEqual(switchCount(false, 5), "", "not read yet: no number");
  assert.strictEqual(switchCount(true, 0), "", "nothing uncommitted: no badge");
  assert.strictEqual(switchCount(true, 6), "6");
  assert.strictEqual(totalsLabel({ files: 6, repos: 3, added: 24, deleted: 5 }), "3 repositories · +24 −5");
  assert.strictEqual(totalsLabel({ files: 1, repos: 1, added: 2, deleted: 0 }), "1 repository · +2 −0");
  assert.strictEqual(totalsLabel({ files: 0, repos: 0, added: 0, deleted: 0 }), "");
  assert.deepStrictEqual(meterParts({ added: 1, modified: 2, deleted: 1 }).map((p) => [p.kind, p.share]), [["added", 0.25], ["modified", 0.5], ["deleted", 0.25]]);
  assert.deepStrictEqual(meterParts({ added: 0, modified: 3, deleted: 0 }).map((p) => p.kind), ["modified"], "empty kinds are left out");
  assert.deepStrictEqual(meterParts({ added: 0, modified: 0, deleted: 0 }), []);
  console.log("ok - the switch's badge, totals and change meter");
}
{
  assert.strictEqual(escapeTarget("commits"), "list");
  assert.strictEqual(escapeTarget("uncommitted"), "worklist", "Escape never sends focus to a hidden list");
  console.log("ok - Escape focuses the list the Log shows");
}
