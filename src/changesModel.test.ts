import * as assert from "assert";
import { combinedTitle, decorationFor, describeChanges, describeCombined, firstOpenable, viewDescription, LOADING, NO_FILES, NO_SELECTION, type ChangesState, type CombinedOpen, type CombinedState, type NodeDesc } from "./changesModel";
import { absoluteTime } from "./webview/view";
import { UNCOMMITTED, type Commit } from "./types";

const NOW = 1790164800;
const commit: Commit = {
  repoId: "/ws/acme-api", sha: "1596c39".padEnd(40, "0"), time: NOW - 2 * 3600, author: "rin", email: "rin@example.com",
  subject: "feat: add retry to uploader (ACME-7)", parents: ["b".repeat(40)],
};
const state = (over: Partial<ChangesState> = {}): ChangesState => ({
  commit, repoRoot: "/ws/acme-api", repoName: "acme-api", status: "ready", message: "feat: add retry to uploader (ACME-7)\n\nfunc: ACME_UPLOAD_005\ntask: ACME-7",
  files: [
    { path: "internal/upload/upload.go", added: 42, deleted: 7 },
    { path: "internal/upload/upload_test.go", added: 88, deleted: 0 },
    { path: "assets/logo.png", added: null, deleted: null },
    { path: "docs/releases.md", oldPath: "docs/release.md", added: 0, deleted: 0 },
  ],
  ...over,
});
const flat = (nodes: NodeDesc[], depth = 0): string[] =>
  nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.label} | ${n.description}`, ...(n.kind === "file" ? [] : flat(n.children, depth + 1))]);

{
  const { message, roots } = describeChanges(state(), NOW);
  assert.strictEqual(message, undefined);
  assert.deepStrictEqual(flat(roots), [
    "feat: add retry to uploader (ACME-7) | 1596c39 · rin · 2h ago",
    "  assets | 1",
    "    logo.png | binary",
    "  docs | 1",
    "    releases.md | ← docs/release.md  +0 −0",
    "  internal/upload | 2",
    "    upload.go | +42 −7",
    "    upload_test.go | +88 −0",
  ]);
  console.log("ok - commit node on top, then the folder tree with +/− descriptions");
}
{
  const [root] = describeChanges(state(), NOW).roots;
  assert.strictEqual(root.kind, "commit");
  assert.ok(root.tooltip.startsWith("feat: add retry to uploader (ACME-7)\n\nfunc: ACME_UPLOAD_005\ntask: ACME-7\n\n"), "full message keeps its line breaks");
  assert.match(root.tooltip, /rin <rin@example\.com> · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · acme-api/);
  assert.ok(root.tooltip.endsWith(commit.sha));
  console.log("ok - the commit tooltip carries the full message, author email, date, repo and SHA");
}
{
  const files = (describeChanges(state(), NOW).roots[0] as { children: NodeDesc[] }).children.flatMap((n) => (n.kind === "folder" ? n.children : [n]));
  const byLabel = new Map(files.map((n) => [n.label, n]));
  const logo = byLabel.get("logo.png")!;
  const upload = byLabel.get("upload.go")!;
  assert.ok(logo.kind === "file" && !logo.openable, "binary files cannot be opened as a text diff");
  assert.ok(upload.kind === "file" && upload.openable && upload.path === "internal/upload/upload.go");
  assert.strictEqual(upload.tooltip, "internal/upload/upload.go");
  assert.strictEqual(byLabel.get("releases.md")!.tooltip, "docs/release.md → docs/releases.md");
  console.log("ok - files carry their full path; binaries are not openable; renames show both paths");
}
{
  const ids = (nodes: NodeDesc[]): string[] => nodes.flatMap((n) => [n.id, ...(n.kind === "file" ? [] : ids(n.children))]);
  const all = ids(describeChanges(state(), NOW).roots);
  assert.strictEqual(new Set(all).size, all.length, "ids are unique so VS Code keeps expand state");
  assert.deepStrictEqual(ids(describeChanges(state(), NOW + 60).roots), all, "ids do not depend on time");
  console.log("ok - node ids are unique and stable");
}
{
  assert.deepStrictEqual(describeChanges(null, NOW), { message: NO_SELECTION, roots: [] });
  assert.strictEqual(NO_SELECTION, "Select a commit in the Log to see its changed files.");
  const loading = describeChanges(state({ status: "loading", files: [] }), NOW);
  assert.strictEqual(loading.message, LOADING);
  assert.strictEqual(loading.roots.length, 1, "the commit node shows while its files load");
  assert.strictEqual(describeChanges(state({ status: "error", files: [], error: "bad object" }), NOW).message, "Could not read this commit: bad object");
  assert.strictEqual(describeChanges(state({ files: [] }), NOW).message, NO_FILES);
  console.log("ok - no selection, loading, error and no-files each have a message");
}
{
  assert.strictEqual(firstOpenable(state().files)?.path, "internal/upload/upload.go");
  assert.strictEqual(firstOpenable([{ path: "a.png", added: null, deleted: null }]), undefined);
  assert.strictEqual(firstOpenable([]), undefined);
  console.log("ok - firstOpenable skips binaries and is undefined when nothing can be opened");
}
{
  assert.deepStrictEqual(decorationFor("A"), { badge: "A", color: "gitDecoration.addedResourceForeground", tooltip: "Added" });
  assert.deepStrictEqual(decorationFor("M"), { badge: "M", color: "gitDecoration.modifiedResourceForeground", tooltip: "Modified" });
  assert.deepStrictEqual(decorationFor("D"), { badge: "D", color: "gitDecoration.deletedResourceForeground", tooltip: "Deleted" });
  assert.deepStrictEqual(decorationFor("R"), { badge: "R", color: "gitDecoration.renamedResourceForeground", tooltip: "Renamed" });
  assert.deepStrictEqual(decorationFor("C"), { badge: "C", color: "gitDecoration.addedResourceForeground", tooltip: "Copied" });
  assert.deepStrictEqual(decorationFor("T"), { badge: "T", color: "gitDecoration.modifiedResourceForeground", tooltip: "Type changed" });
  assert.strictEqual(decorationFor(undefined), undefined);
  console.log("ok - each change status maps to the theme's git decoration color and a badge");
}

{
  const wt: Commit = { repoId: "/ws/acme-web", sha: UNCOMMITTED, time: NOW, author: "", email: "", subject: "Uncommitted changes", parents: ["c".repeat(40)] };
  const d = describeChanges({ commit: wt, repoRoot: "/ws/acme-web", repoName: "acme-web", status: "ready", message: "", files: [
    { path: "src/app.ts", added: 3, deleted: 1, status: "M", staged: false },
    { path: "src/staged.ts", added: 1, deleted: 0, status: "M", staged: true },
    { path: "notes.md", added: 0, deleted: 0, status: "A", staged: false, untracked: true },
  ] }, NOW);
  const root = d.roots[0];
  assert.strictEqual(root.label, "acme-web", "named after its repository: the Log's Uncommitted side shows one at a time");
  assert.match(root.tooltip, /Uncommitted view/, "the tooltip says where to stage and commit");
  assert.strictEqual(root.description, "3 files · not committed", "no sha, author or age for work that is not a commit");
  const files = (n: NodeDesc): NodeDesc[] => (n.kind === "file" ? [n] : n.children.flatMap(files));
  const byLabel = new Map(files(root).map((f) => [f.label, f.description]));
  assert.strictEqual(byLabel.get("staged.ts"), "+1 −0 · staged", "fully staged files say so");
  assert.strictEqual(byLabel.get("notes.md"), "new", "an untracked file has no counts yet");
  assert.strictEqual(byLabel.get("app.ts"), "+3 −1");
  console.log("ok - uncommitted changes describe themselves: file count, staged, new");
}


// The view's title says what it shows: a commit, or a repository's uncommitted work.
assert.strictEqual(viewDescription(null), "");
assert.strictEqual(viewDescription(state()), `acme-api · 1596c39 · ${state().files.length} files`);
assert.strictEqual(viewDescription(state({ status: "loading", files: [] })), "acme-api · 1596c39");
assert.strictEqual(viewDescription(state({ commit: { ...commit, sha: UNCOMMITTED }, files: [state().files[0]] })), "acme-api · uncommitted · 1 file");
console.log("ok - the Changes view's description names the repository and the commit, or says uncommitted");

// Combined Changes: several commits, one tree.
{
  const sha = (c: string) => c.repeat(40);
  const mk = (repoId: string, s: string, subject: string, author: string): Commit => ({ repoId, sha: s, time: NOW - 3600, author, email: `${author}@example.com`, subject, parents: [sha("f")] });
  const a = mk("/ws/acme-web", "a3f91c2".padEnd(40, "0"), "fix(header): stop the title overflowing", "dana");
  const c = mk("/ws/acme-web", "c7d20e5".padEnd(40, "0"), "fix(header): padding on small screens", "dana");
  const p1 = mk("/ws/acme-api", "5be07d4".padEnd(40, "0"), "api: add GET /status", "dana");
  const p3 = mk("/ws/acme-api", "48f0b1d".padEnd(40, "0"), "api: /status reports the version", "dana");
  const x = "9c4e1a8".padEnd(40, "0");
  const open = (repoId: string, path: string, shas: Commit[], mode: CombinedOpen["mode"], over: Partial<CombinedOpen> = {}): CombinedOpen =>
    ({ repoId, path, status: "M", beforeRef: sha("f"), beforePath: path, shas: shas.map((s) => s.sha), mode, included: [], ...over });
  const s: CombinedState = {
    status: "ready", count: 4, noNetChange: ["src/debug.ts"], unselected: { [x]: "header: wider title, rem font size" },
    repos: [
      { repoId: "/ws/acme-web", repoName: "acme-web", accent: 1, commits: [a, c], files: [
        open("/ws/acme-web", "src/header.ts", [a, c], "merge", { included: [x] }),
        open("/ws/acme-web", "src/header.css", [a, c], "fallback", { reason: "conflict", included: [x] }),
      ] },
      { repoId: "/ws/acme-api", repoName: "acme-api", accent: 3, commits: [p1, p3], files: [
        open("/ws/acme-api", "routes/status.ts", [p1, p3], "fast", { status: "A", beforeRef: null }),
        open("/ws/acme-api", "routes/index.ts", [p1], "fast"),
      ] },
    ],
  };
  const d = describeCombined(s);
  assert.strictEqual(d.description, "4 commits · 2 repositories");
  assert.strictEqual(d.message, "1 file with no net change: src/debug.ts");
  assert.deepStrictEqual(flat(d.roots), [
    "acme-web | 2 commits",
    "  src | 2",
    "    header.css | ⚠ a3f9 · c7d2",
    "    header.ts | a3f9 · c7d2",
    "acme-api | 2 commits",
    "  routes | 2",
    "    index.ts | 5be0",
    "    status.ts | 5be0 · 48f0",
  ]);
  assert.deepStrictEqual(d.roots.map((r) => r.kind), ["repo", "repo"]);
  assert.strictEqual(d.roots[0].tooltip, `a3f91c2 fix(header): stop the title overflowing · dana · ${absoluteTime(a.time)}\nc7d20e5 fix(header): padding on small screens · dana · ${absoluteTime(c.time)}`);
  const files = (n: NodeDesc): NodeDesc[] => (n.kind === "file" ? [n] : n.children.flatMap(files));
  const css = files(d.roots[0]).find((n) => n.label === "header.css")!;
  assert.strictEqual(css.tooltip, "Includes changes from 1 unselected commit: 9c4e1a8 header: wider title, rem font size");
  assert.strictEqual(css.kind === "file" && css.combined?.mode, "fallback");
  assert.strictEqual(css.kind === "file" && css.owner.sha, c.sha, "file actions act on the newest selected commit");
  assert.strictEqual(describeCombined({ ...s, noNetChange: ["a.ts", "b.ts"] }).message, "2 files with no net change: a.ts, b.ts");
  assert.strictEqual(describeCombined({ ...s, status: "loading", repos: [] }).message, LOADING);
  assert.strictEqual(describeCombined({ ...s, repos: [s.repos[0]], count: 2 }).description, "2 commits · 1 repository");
  console.log("ok - Combined Changes: repository roots, each file once, ⚠ and no-net-change rows");

  assert.strictEqual(combinedTitle(open("/ws/acme-web", "src/header.ts", [a, c], "merge"), "acme-web"), "header.ts (2 selected commits)");
  assert.strictEqual(combinedTitle(open("/ws/acme-web", "src/header.css", [a, c], "fallback", { reason: "conflict", included: [x] }), "acme-web"), "header.css (a3f91c2^ ↔ c7d20e5, includes 1 unselected commit)");
  assert.strictEqual(combinedTitle(open("/ws/acme-web", "img/logo.png", [a, c], "fallback", { reason: "binary" }), "acme-web"), "logo.png (a3f91c2^ ↔ c7d20e5, binary)");
  assert.strictEqual(combinedTitle(open("/ws/acme-web", "src/header.ts", [a], "fast"), "acme-web"), "header.ts (a3f91c2) — acme-web");
  console.log("ok - Combined Changes diff titles");
}
