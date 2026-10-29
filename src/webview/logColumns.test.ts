import * as assert from "assert";
import { DEFAULT_COLUMNS, MESSAGE_MIN, columnPrefs, layoutColumns, type ColumnInput } from "./logColumns";

const base: ColumnInput = { history: false, width: 1200, ch: 7, repoChars: 9, graphAuto: 60, hash: false, prefs: DEFAULT_COLUMNS };
const ids = (i: ColumnInput) => layoutColumns(i).columns.map((c) => c.id).join(" ");
const px = (i: ColumnInput, id: string) => layoutColumns(i).columns.find((c) => c.id === id)?.px;

{
  const l = layoutColumns(base);
  assert.strictEqual(ids(base), "repo graph message author date");
  // The repository column: the longest name + 2ch; the author 10ch (at least 48px); the date 8ch.
  assert.deepStrictEqual([l.columns[0].px, px(base, "graph"), px(base, "author"), px(base, "date")], [77, 60, 70, 56]);
  assert.strictEqual(l.template, "77px 60px minmax(0, 1fr) 70px 56px");
  assert.deepStrictEqual([l.gap, l.narrow, l.repoName, l.graph], [10, false, 77, 60]);
  assert.strictEqual(px({ ...base, repoChars: 80 }, "repo"), 300, "never more than a quarter");
  assert.strictEqual(px({ ...base, repoChars: 2 }, "repo"), 72, "never less than 72px");
  assert.strictEqual(ids({ ...base, hash: true, changes: "bar" }), "repo graph message hash author changes date");
  assert.deepStrictEqual([px({ ...base, changes: "bar" }, "changes"), layoutColumns({ ...base, changes: "bar" }).changesStage], [118, "full"], "the Log's width picks the stage");
  assert.deepStrictEqual([px({ ...base, width: 800, changes: "numbers" }, "changes"), layoutColumns({ ...base, width: 800, changes: "numbers" }).changesStage], [52, "mini"]);
  console.log("ok - the Log's columns: repository, graph, message, hash, author, changes, date, at their automatic widths");
}

{
  const narrow = { ...base, width: 700, hash: true, changes: "bar" as const };
  const l = layoutColumns(narrow);
  assert.strictEqual(ids(narrow), "repo graph message changes date", "narrow: the strip, no hash or author");
  assert.deepStrictEqual([l.narrow, l.gap, l.columns[0].px, px(narrow, "changes"), px(narrow, "date"), l.changesStage, l.repoName], [true, 6, 3, 18, 49, "icon", null]);
  const sizedNarrow = layoutColumns({ ...narrow, prefs: { ...DEFAULT_COLUMNS, widths: { author: 200, date: 150 } } });
  assert.strictEqual(sizedNarrow.columns.find((c) => c.id === "date")?.px, 49, "the user's widths wait for the wide layout");
  console.log("ok - a narrow Log: the repository a strip, no hash or author, the Changes column a ring");
}

{
  const h = { ...base, history: true, hash: true, changes: "bar" as const };
  assert.strictEqual(ids(h), "repo graph message file hash author date", "File History: its change column, no Changes column");
  assert.deepStrictEqual([px(h, "repo"), px(h, "file")], [4, 98]);
  assert.deepStrictEqual([ids({ ...h, width: 600 }), px({ ...h, width: 600 }, "file"), px({ ...h, width: 400 }, "file"), layoutColumns({ ...h, width: 400 }).tiny], ["repo graph message file date", 77, 14, true]);
  console.log("ok - File History: the strip, the file's change, narrower and narrower");
}

{
  const sized = (widths: Record<string, number>, extra: Partial<ColumnInput> = {}) => ({ ...base, ...extra, prefs: { ...DEFAULT_COLUMNS, widths } });
  assert.deepStrictEqual([px(sized({ repo: 150 }), "repo"), px(sized({ author: 160 }), "author"), px(sized({ graph: 120 }), "graph")], [150, 160, 120]);
  assert.deepStrictEqual([px(sized({ repo: 10 }), "repo"), px(sized({ repo: 2000 }), "repo"), px(sized({ author: 5 }), "author")], [72, 480, 48], "clamped to each column's range");
  assert.strictEqual(layoutColumns(sized({ repo: 150 })).repoName, 150, "fitNames fits names to the sized column");
  // A sized Changes column draws the widest stage it holds.
  const c = layoutColumns(sized({ changes: 90 }, { changes: "bar" }));
  assert.deepStrictEqual([c.columns.find((x) => x.id === "changes")?.px, c.changesStage], [90, "compact"]);
  // Message keeps its minimum: the widest sized column gives way, never below its automatic width.
  const tight = layoutColumns(sized({ repo: 480, author: 360, date: 200 }, { width: 900 }));
  const room = 900 - tight.gap * (tight.columns.length - 1) - tight.columns.reduce((s, x) => s + (x.px ?? 0), 0);
  assert.ok(room >= MESSAGE_MIN - 1, `message keeps ${MESSAGE_MIN}px (has ${room})`);
  console.log("ok - sized columns: clamped, the Changes stage from the column's own width, Message keeps its room");
}

{
  const hidden = { ...base, changes: "squares" as const, prefs: { ...DEFAULT_COLUMNS, hidden: ["repo", "author", "date"] as ("repo" | "author" | "date")[] } };
  const l = layoutColumns(hidden);
  assert.deepStrictEqual([ids(hidden), l.columns[0].px, l.repoName], ["repo graph message changes", 3, null], "hidden: the repository's name (its strip stays), the author, the date");
  assert.strictEqual(px({ ...base, prefs: { ...DEFAULT_COLUMNS, dates: "absolute" } }, "date"), 112, "an absolute date takes 16ch");
  console.log("ok - the Columns menu hides the repository's name, the author and the date; absolute dates widen theirs");
}

{
  assert.deepStrictEqual(columnPrefs(undefined), DEFAULT_COLUMNS);
  assert.deepStrictEqual(columnPrefs({ widths: { repo: 140.4, graph: -3, bogus: 9, date: "x" }, hidden: ["author", "graph", "nope"], dates: "absolute" }),
    { widths: { repo: 140 }, hidden: ["author"], dates: "absolute" }, "anything unknown or out of range is dropped");
  console.log("ok - saved column prefs are read back defensively");
}
