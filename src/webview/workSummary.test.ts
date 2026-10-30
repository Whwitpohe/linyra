import * as assert from "assert";
import { DEFAULT_FILTER } from "../filterModel";
import type { WorkRow } from "../protocol";
import { lookingForCommits, moveWithWork, summaryKey, workSummary, type WorkSummaryInput } from "./workSummary";

const row = (repoId: string, edited: string, editedAt: number | null = 1_700_000_000_000): WorkRow => ({ repoId, preview: "src/app.ts", counts: { added: 1, modified: 2, deleted: 0, renamed: 0 },
  head: "a".repeat(40), tags: [], edited, editedAt, canStage: true, hasStaged: false, hasChanges: true });
const input = (over: Partial<WorkSummaryInput> = {}): WorkSummaryInput => ({
  mode: "commits", history: false, filter: DEFAULT_FILTER, today: "2026-10-30",
  work: { known: true, totals: { files: 12, added: 143, deleted: 20 }, rows: [row("/work/acme-web", "edited 2m ago"), row("/work/acme-api", "edited 1h ago")] },
  ...over,
});

{
  const s = workSummary(input())!;
  assert.deepStrictEqual(s.repos.map((r) => r.repoId), ["/work/acme-web", "/work/acme-api"], "most recently edited first, as the Uncommitted side lists them");
  assert.deepStrictEqual([s.files, s.added, s.deleted, s.edited, s.editedAt], [12, 143, 20, "edited 2m ago", 1_700_000_000_000]);
  assert.deepStrictEqual(s.kinds, { added: 2, modified: 4, deleted: 0, renamed: 0 }, "files by kind, summed");
  assert.strictEqual(workSummary(input({ mode: "uncommitted" })), null, "the Uncommitted side shows the work itself");
  assert.strictEqual(workSummary(input({ history: true })), null, "File History has its own row");
  assert.strictEqual(workSummary(input({ work: { known: false, totals: { files: 0, added: 0, deleted: 0 }, rows: [] } })), null, "not read yet: no guess");
  assert.strictEqual(workSummary(input({ work: { known: true, totals: { files: 0, added: 0, deleted: 0 }, rows: [] } })), null, "nothing uncommitted: no row");
  console.log("ok - the summary row: the ticked repositories' work, on the Commits side only, when there is some");
}

{
  const today = "2026-10-30";
  assert.strictEqual(lookingForCommits(DEFAULT_FILTER, today), false, "the default 24 hours, every branch");
  for (const f of [{ text: "retry" }, { text: "a42a50e" }, { author: "rin" }, { mine: true }, { authors: ["rin"] }, { path: "src/" }, { date: "custom" as const, to: "2026-10-01" }]) {
    assert.strictEqual(lookingForCommits({ ...DEFAULT_FILTER, ...f }, today), true, JSON.stringify(f));
    assert.strictEqual(workSummary(input({ filter: { ...DEFAULT_FILTER, ...f } })), null, JSON.stringify(f));
  }
  for (const f of [{ text: "   " }, { branches: ["develop"] }, { date: "7d" as const }, { date: "custom" as const, from: "2026-10-01", to: "2026-10-30" }, { sort: "topo" as const }]) {
    assert.strictEqual(lookingForCommits({ ...DEFAULT_FILTER, ...f } as typeof DEFAULT_FILTER, today), false, JSON.stringify(f));
  }
  console.log("ok - a search, an author, a file or a range that ended leaves the row out; branches, order and recent dates keep it");
}

{
  // The row first (-1), then the commits 0…4.
  assert.strictEqual(moveWithWork("ArrowUp", 0, 5, 3, true), -1, "↑ from the newest commit reaches the row");
  assert.strictEqual(moveWithWork("ArrowUp", -1, 5, 3, true), -1, "and stays there");
  assert.strictEqual(moveWithWork("ArrowDown", -1, 5, 3, true), 0);
  assert.strictEqual(moveWithWork("Home", 3, 5, 3, true), -1);
  assert.strictEqual(moveWithWork("End", -1, 5, 3, true), 4);
  assert.strictEqual(moveWithWork("PageUp", 1, 5, 3, true), -1);
  assert.strictEqual(moveWithWork("PageDown", -1, 5, 3, true), 2);
  assert.strictEqual(moveWithWork("ArrowUp", 0, 5, 3, false), 0, "without the row, as before");
  assert.strictEqual(moveWithWork("x", 0, 5, 3, true), null);
  assert.strictEqual(moveWithWork("ArrowDown", -1, 0, 3, true), -1, "no commits: the row is all there is");
  console.log("ok - the arrow keys walk from the summary row into the commits and back");
}

{
  const a = workSummary(input()), b = workSummary(input());
  assert.strictEqual(summaryKey(a), summaryKey(b), "the same work: the same key, the row is not rebuilt");
  assert.notStrictEqual(summaryKey(a), summaryKey(workSummary(input({ work: { ...input().work, totals: { files: 13, added: 143, deleted: 20 } } }))));
  assert.strictEqual(summaryKey(null), "");
  console.log("ok - the row's key changes with what it draws");
}
