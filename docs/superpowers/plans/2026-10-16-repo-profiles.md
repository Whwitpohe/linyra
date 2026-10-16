# Repo List Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Named groups of repositories ("backend", "frontend") saved in the workspace setting `polylog.profiles`, shown as rows at the top of the Repo List; clicking one ticks exactly its repositories.

**Architecture:** A pure module (`src/profileModel.ts`) parses, resolves and edits profiles. `LogView` reads the setting, resolves it against the discovered repositories, sends the resolved profiles to the webview with `init`, and runs the profile commands (which change only `filter.repoIds`, through the existing `setRepoFilter`). The webview's `RepoPane` draws profile rows and the ＋ Save as profile… row and works out which profile is active from the ticks, with the same pure helpers.

**Tech Stack:** TypeScript, esbuild, VS Code extension API (^1.85), plain-DOM webview; unit tests are plain `assert` + `console.log("ok - …")`; integration tests are mocha in `@vscode/test-electron`.

**Spec:** `docs/superpowers/specs/2026-10-16-repo-profiles-design.md`

## Global Constraints

- Constraint 1 (CLAUDE.md): no index, no cache, no filtering in JavaScript. A profile only sets `filter.repoIds`; `git log` does the rest.
- Constraint 2: every color from `--vscode-*` variables; no codicon font (it would be a bundled webfont): icons are CSS or inline SVG.
- Constraint 3: neutral names only (`acme-web`, `acme-api`, `acme-libs`, `backend`, `frontend`, `dana`, `rin`).
- Constraint 4: never block the extension host; every write is async.
- Constraint 5: do not bump the version, edit CHANGELOG, tag or publish.
- Setting: `polylog.profiles`, object of `string → string[]`, `"scope": "window"`, written with `vscode.ConfigurationTarget.Workspace`.
- Entries are repository paths relative to their workspace folder with `/` separators; `"."` is the folder itself; multi-root entries are prefixed with the folder's name.
- Each new `src/*.test.ts` must be appended to the `test:unit` script in `package.json`, or it never runs.
- Git: commit on the current branch with `git add <files>` + `git commit` only; never `checkout/switch/reset/rebase/stash/branch`. Identity is the repo's local `lntvan166 <lntvan166@gmail.com>`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The zsh line `compdef:153: _comps: assignment to invalid subscript range` in command output is harmless noise.

## Review Focus

1. **Multi-root workspace**: entries are `folderName/rel`; a repository that *is* a workspace folder is `folderName`. Pinned in Task 1 (`repoKey` tests).
2. **A repository that is the workspace folder itself** (single-root): its entry is `"."`. Pinned in Task 1.
3. **A hand-edited, malformed setting** (a string, numbers, blank names, duplicate entries): ignored entry by entry, never an error. Pinned in Task 1 (`readProfiles`) and Task 2 (integration: a bad value leaves the Log working).
4. **A profile whose repositories are all missing** ticks none, and **a profile of every repository** switches to All, with both rows highlighted. Pinned in Task 1 (`profileFilter`, `activeProfiles`).
5. **Names that differ only by case** ("Backend" vs "backend") are treated as the same name when saving or renaming, so the Repo List never shows two rows a person reads as one. Pinned in Task 1 (`nameProblem`).

---

### Task 1: The pure profile model

**Files:**
- Create: `src/profileModel.ts`
- Create: `src/profileModel.test.ts`
- Modify: `package.json` (the `test:unit` script)

**Interfaces:**
- Consumes: nothing.
- Produces (exact):
  - `type Profiles = Record<string, string[]>`
  - `interface ResolvedProfile { name: string; ids: string[]; missing: string[] }`
  - `interface Folder { name: string; path: string }`
  - `readProfiles(raw: unknown): Profiles`
  - `profileNames(p: Profiles): string[]`
  - `repoKey(root: string, folders: readonly Folder[], caseInsensitive?: boolean): string`
  - `resolveProfiles(p: Profiles, repos: readonly { id: string; key: string }[]): ResolvedProfile[]`
  - `activeProfiles(resolved: readonly ResolvedProfile[], repoIds: readonly string[] | null, allIds: readonly string[]): string[]`
  - `showSaveRow(resolved: readonly ResolvedProfile[], repoIds: readonly string[] | null, allIds: readonly string[]): boolean`
  - `profileFilter(p: ResolvedProfile, allIds: readonly string[]): string[] | null`
  - `nameProblem(p: Profiles, name: string, current?: string): string | undefined`
  - `saveProfile(p: Profiles, name: string, keys: readonly string[]): Profiles`
  - `renameProfile(p: Profiles, from: string, to: string): Profiles`
  - `deleteProfile(p: Profiles, name: string): Profiles`
  - `setMembership(p: Profiles, key: string, names: readonly string[]): Profiles`

- [ ] **Step 1: Write the failing test**

Create `src/profileModel.test.ts`:

```ts
import * as assert from "assert";
import { activeProfiles, deleteProfile, nameProblem, profileFilter, profileNames, readProfiles, renameProfile, repoKey, resolveProfiles, saveProfile, setMembership, showSaveRow } from "./profileModel";

{
  assert.deepStrictEqual(readProfiles(undefined), {});
  assert.deepStrictEqual(readProfiles("backend"), {}, "not an object");
  assert.deepStrictEqual(readProfiles(["acme-api"]), {}, "an array is not a map");
  assert.deepStrictEqual(
    readProfiles({ backend: ["acme-api", 3, "", " acme-libs ", "acme-api"], "  ": ["acme-web"], frontend: "acme-web", " ops ": [] }),
    { backend: ["acme-api", "acme-libs"], ops: [] },
    "bad entries and blank names are dropped, names and entries trimmed, duplicates once",
  );
  assert.deepStrictEqual(profileNames({ frontend: [], Backend: [], api: [] }), ["api", "Backend", "frontend"], "sorted ignoring case");
  console.log("ok - readProfiles is lenient; profileNames sorts ignoring case");
}
{
  const one = [{ name: "ws", path: "/home/dana/ws" }];
  assert.strictEqual(repoKey("/home/dana/ws/acme-api", one), "acme-api");
  assert.strictEqual(repoKey("/home/dana/ws/services/acme-api/", one), "services/acme-api", "nested, trailing slash");
  assert.strictEqual(repoKey("/home/dana/ws", one), ".", "the workspace folder itself");
  assert.strictEqual(repoKey("/home/dana/wsx/acme-api", one), "/home/dana/wsx/acme-api", "a sibling folder with the same prefix is outside");
  const two = [{ name: "web", path: "/src/web" }, { name: "api", path: "/src/api" }];
  assert.strictEqual(repoKey("/src/api/acme-api", two), "api/acme-api", "multi-root: the folder's name first");
  assert.strictEqual(repoKey("/src/web", two), "web", "multi-root: a folder that is a repository");
  const win = [{ name: "ws", path: "C:\\Users\\dana\\ws" }];
  assert.strictEqual(repoKey("c:\\users\\dana\\ws\\acme-web", win, true), "acme-web", "Windows: separators and case");
  console.log("ok - repoKey: relative to the workspace folder, '/' separators, multi-root names");
}
{
  const repos = [{ id: "/ws/acme-web", key: "acme-web" }, { id: "/ws/acme-api", key: "acme-api" }, { id: "/ws/acme-libs", key: "acme-libs" }];
  const all = repos.map((r) => r.id);
  const resolved = resolveProfiles({ frontend: ["acme-web", "acme-libs"], backend: ["acme-api", "acme-libs", "acme-jobs"], gone: ["acme-jobs"], every: ["acme-web", "acme-api", "acme-libs"] }, repos);
  assert.deepStrictEqual(resolved.map((p) => [p.name, p.ids, p.missing]), [
    ["backend", ["/ws/acme-api", "/ws/acme-libs"], ["acme-jobs"]],
    ["every", all, []],
    ["frontend", ["/ws/acme-web", "/ws/acme-libs"], []],
    ["gone", [], ["acme-jobs"]],
  ], "ids in Repo List order; missing entries kept aside");
  const [backend, every, , gone] = resolved;
  assert.deepStrictEqual(activeProfiles(resolved, ["/ws/acme-libs", "/ws/acme-api"], all), ["backend"], "same set, any order");
  assert.deepStrictEqual(activeProfiles(resolved, ["/ws/acme-api"], all), [], "a subset is not the profile");
  assert.deepStrictEqual(activeProfiles(resolved, null, all), ["every"], "All matches a profile of every repository");
  assert.deepStrictEqual(activeProfiles(resolved, [], all), [], "an empty profile is never active");
  assert.deepStrictEqual(profileFilter(backend, all), ["/ws/acme-api", "/ws/acme-libs"]);
  assert.strictEqual(profileFilter(every, all), null, "every repository is All");
  assert.deepStrictEqual(profileFilter(gone, all), [], "nothing found ticks nothing");
  assert.strictEqual(showSaveRow(resolved, null, all), false, "All: nothing to save");
  assert.strictEqual(showSaveRow(resolved, [], all), false, "nothing ticked");
  assert.strictEqual(showSaveRow(resolved, ["/ws/acme-api", "/ws/acme-libs"], all), false, "already a profile");
  assert.strictEqual(showSaveRow(resolved, ["/ws/acme-web"], all), true);
  assert.strictEqual(showSaveRow([], ["/ws/acme-web"], all), true, "also with no profiles yet");
  console.log("ok - resolveProfiles, activeProfiles, profileFilter, showSaveRow");
}
{
  const p = { backend: ["acme-api"], frontend: ["acme-web", "acme-libs"] };
  assert.strictEqual(nameProblem(p, "  "), "Enter a name.");
  assert.strictEqual(nameProblem(p, "frontend"), 'A profile named "frontend" already exists.');
  assert.strictEqual(nameProblem(p, "Frontend"), 'A profile named "frontend" already exists.', "case does not make a new name");
  assert.strictEqual(nameProblem(p, "Backend", "backend"), undefined, "renaming to its own name in another case is fine");
  assert.strictEqual(nameProblem(p, "ops"), undefined);
  assert.deepStrictEqual(saveProfile(p, " ops ", ["acme-api", "acme-api"]), { ...p, ops: ["acme-api"] });
  assert.deepStrictEqual(saveProfile(p, "backend", ["acme-libs"]).backend, ["acme-libs"], "replaces");
  assert.deepStrictEqual(Object.keys(renameProfile(p, "backend", "api")), ["api", "frontend"], "keeps its place");
  assert.deepStrictEqual(renameProfile(p, "backend", "api").api, ["acme-api"]);
  assert.strictEqual(renameProfile(p, "nope", "api"), p, "unknown: unchanged");
  assert.deepStrictEqual(deleteProfile(p, "backend"), { frontend: ["acme-web", "acme-libs"] });
  assert.deepStrictEqual(p.backend, ["acme-api"], "edits never mutate");
  assert.deepStrictEqual(setMembership(p, "acme-libs", ["backend"]), { backend: ["acme-api", "acme-libs"], frontend: ["acme-web"] }, "added where ticked, removed where not");
  assert.deepStrictEqual(setMembership(p, "acme-api", ["backend"]), p, "already right: same lists");
  console.log("ok - nameProblem and the edits");
}
```

- [ ] **Step 2: Append the test to `test:unit` and run it to see it fail**

In `package.json`, at the end of the `test:unit` script string (after `node out/blameModel.test.cjs`), append:

```
 && esbuild src/profileModel.test.ts --bundle --platform=node --format=cjs --outfile=out/profileModel.test.cjs && node out/profileModel.test.cjs
```

Run: `npx esbuild src/profileModel.test.ts --bundle --platform=node --format=cjs --outfile=out/profileModel.test.cjs --log-level=error`
Expected: FAIL — `Could not resolve "./profileModel"`.

- [ ] **Step 3: Write the implementation**

Create `src/profileModel.ts`:

```ts
// Repo List profiles: named groups of repositories, kept in the workspace setting
// polylog.profiles. Pure: no vscode import. A profile only chooses which repositories
// git log runs in; it filters nothing itself.

/** Profile name → repositories, each as its path relative to its workspace folder. */
export type Profiles = Record<string, string[]>;
/** A profile against the repositories found: their ids (Repo List order), and entries found nowhere. */
export interface ResolvedProfile { name: string; ids: string[]; missing: string[] }
export interface Folder { name: string; path: string }

/** The setting as written by hand or by Polylog: anything malformed is skipped, never an error. */
export function readProfiles(raw: unknown): Profiles {
  const out: Profiles = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = key.trim();
    if (!name || !Array.isArray(value)) continue;
    const entries = value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x !== "");
    out[name] = [...new Set(entries)];
  }
  return out;
}

export function profileNames(p: Profiles): string[] {
  return Object.keys(p).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

const slashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * How a profile names a repository: its path relative to the workspace folder holding it
 * (the innermost), "/" separators, "." for the folder itself; in a multi-root workspace the
 * folder's name comes first. Outside every folder: the absolute path, "/" separators.
 */
export function repoKey(root: string, folders: readonly Folder[], caseInsensitive = false): string {
  const r = slashes(root);
  const same = (a: string, b: string) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  let best: { folder: Folder; base: string; rel: string } | undefined;
  for (const folder of folders) {
    const base = slashes(folder.path);
    const rel = same(r, base) ? "" : r.length > base.length && same(r.slice(0, base.length + 1), `${base}/`) ? r.slice(base.length + 1) : null;
    if (rel !== null && (!best || base.length > best.base.length)) best = { folder, base, rel };
  }
  if (!best) return r;
  if (folders.length > 1) return best.rel ? `${best.folder.name}/${best.rel}` : best.folder.name;
  return best.rel || ".";
}

/** Each profile (sorted by name) against the repositories found, in their order. */
export function resolveProfiles(p: Profiles, repos: readonly { id: string; key: string }[]): ResolvedProfile[] {
  const known = new Set(repos.map((r) => r.key));
  return profileNames(p).map((name) => {
    const wanted = new Set(p[name]);
    return { name, ids: repos.filter((r) => wanted.has(r.key)).map((r) => r.id), missing: p[name].filter((k) => !known.has(k)) };
  });
}

/** The profiles the ticks are exactly (repoIds null = every repository). Derived, never stored. */
export function activeProfiles(resolved: readonly ResolvedProfile[], repoIds: readonly string[] | null, allIds: readonly string[]): string[] {
  const shown = new Set(repoIds ?? allIds);
  return resolved.filter((p) => p.ids.length > 0 && p.ids.length === shown.size && p.ids.every((id) => shown.has(id))).map((p) => p.name);
}

/** The ＋ Save as profile… row: some repositories ticked, and they are neither All nor a profile. */
export function showSaveRow(resolved: readonly ResolvedProfile[], repoIds: readonly string[] | null, allIds: readonly string[]): boolean {
  return repoIds !== null && repoIds.length > 0 && activeProfiles(resolved, repoIds, allIds).length === 0;
}

/** The repo filter a profile sets: its repositories in Repo List order, or null when that is all of them. */
export function profileFilter(p: ResolvedProfile, allIds: readonly string[]): string[] | null {
  const ids = allIds.filter((id) => p.ids.includes(id));
  return ids.length === allIds.length && ids.length > 0 ? null : ids;
}

/** Why a name cannot be used (undefined: it can). Names differing only in case are the same name. */
export function nameProblem(p: Profiles, name: string, current?: string): string | undefined {
  const n = name.trim();
  if (!n) return "Enter a name.";
  const clash = Object.keys(p).find((k) => k.toLowerCase() === n.toLowerCase() && k !== current);
  return clash === undefined ? undefined : `A profile named "${clash}" already exists.`;
}

export function saveProfile(p: Profiles, name: string, keys: readonly string[]): Profiles {
  return { ...p, [name.trim()]: [...new Set(keys)] };
}

/** Renamed in place: the setting keeps its order. */
export function renameProfile(p: Profiles, from: string, to: string): Profiles {
  if (!(from in p)) return p;
  const out: Profiles = {};
  for (const [k, v] of Object.entries(p)) out[k === from ? to.trim() : k] = v;
  return out;
}

export function deleteProfile(p: Profiles, name: string): Profiles {
  const out = { ...p };
  delete out[name];
  return out;
}

/** One repository's memberships: in every profile of `names`, in no other. */
export function setMembership(p: Profiles, key: string, names: readonly string[]): Profiles {
  const out: Profiles = {};
  for (const [n, keys] of Object.entries(p)) {
    const want = names.includes(n);
    out[n] = want ? (keys.includes(key) ? keys : [...keys, key]) : keys.filter((k) => k !== key);
  }
  return out;
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx esbuild src/profileModel.test.ts --bundle --platform=node --format=cjs --outfile=out/profileModel.test.cjs --log-level=error && node out/profileModel.test.cjs`
Expected: four `ok - …` lines, exit 0. Then `npm test` (whole unit suite) exits 0 and `npm run typecheck` passes.

- [ ] **Step 5: Commit**

```bash
git add src/profileModel.ts src/profileModel.test.ts package.json
git commit -F - <<'EOF'
feat(profiles): pure model — parse, resolve and edit polylog.profiles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: The host reads profiles, posts them, and switches

**Files:**
- Modify: `package.json` (`contributes.configuration.properties`: the setting; `contributes.commands`, `menus.view/title`, `menus.commandPalette`, `menus.webview/context`: Switch and Show)
- Modify: `src/protocol.ts` (`init` carries `profiles`)
- Modify: `src/uncommittedView.ts` (`Ask` gains `pick`, `pickMany`, and `input` options; `UncommittedViewDeps.ask`)
- Modify: `src/logView.ts` (`LogDeps.ask`, resolve + post, `profilesChanged`, `profileShow`, `profileSwitch`, snapshot `profiles`)
- Modify: `src/extension.ts` (one shared `Ask`; register commands; config listener)
- Modify: `dev/harness/shim.ts` (the mock `init` gets `profiles`)
- Test: `src/integration/log.itest.ts`

**Interfaces:**
- Consumes (Task 1): `readProfiles`, `repoKey`, `resolveProfiles`, `activeProfiles`, `profileFilter`, `ResolvedProfile`, `Profiles`.
- Produces:
  - `HostMessage` `init` gains `profiles: ResolvedProfile[]`.
  - `Ask.input(prompt: string, placeHolder: string, opts?: { value?: string; validate?: (v: string) => string | vscode.InputBoxValidationMessage | undefined }): Promise<string | undefined>`
  - `Ask.pick(items: readonly vscode.QuickPickItem[], placeHolder: string): Promise<number | undefined>` (index of the chosen item; testing: the queued answer is a label)
  - `Ask.pickMany(items: readonly vscode.QuickPickItem[], placeHolder: string): Promise<number[] | undefined>` (indexes; testing: the queued answer is a JSON array of labels)
  - `LogView`: `resolvedProfiles(): ResolvedProfile[]`, `profileKeys(): { id: string; key: string }[]`, `rawProfiles(): Profiles`, `profilesChanged(): void`, `profileShow(arg: unknown): Promise<void>`, `profileSwitch(): Promise<void>`, `contextProfile(arg: unknown): ResolvedProfile | undefined` (private), `setRepoFilter` (existing, private).
  - `LogSnapshot.profiles: ResolvedProfile[]`.
  - Commands `polylog.profileSwitch` ("Switch Profile…"), `polylog.profileShow` ("Show This Profile"); webview context `{ webviewSection: "profile", profile: string }`.

- [ ] **Step 1: Write the failing integration test**

In `src/integration/log.itest.ts`, add before `it("a diff side shows who last changed the cursor's line, as of that commit"`:

```ts
  it("profiles: read from polylog.profiles, switched by Show and Switch Profile…, other filters kept", async () => {
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const id = (name: string) => s0.repos.find((r) => r.name === name)!.id;
    const cfg = vscode.workspace.getConfiguration("polylog");
    try {
      await cfg.update("profiles", { backend: ["acme-api", "acme-libs", "acme-jobs"], web: ["acme-web"], bad: "acme-web" }, vscode.ConfigurationTarget.Workspace);
      let s = await until("profiles resolved", (x) => x.profiles.length === 2);
      assert.deepStrictEqual(s.profiles.map((p) => [p.name, p.ids, p.missing]), [
        ["backend", [id("acme-api"), id("acme-libs")], ["acme-jobs"]],
        ["web", [id("acme-web")], []],
      ], "a malformed profile is skipped; a missing repository is reported, not an error");
      // A filter set beforehand stays: a profile changes only the repositories.
      await send({ type: "filter", filter: { ...s.filter, author: "dana" } });
      await vscode.commands.executeCommand("polylog.profileShow", { webviewSection: "profile", profile: "backend" });
      s = await until("backend ticked", (x) => x.filter.repoIds?.join() === [id("acme-api"), id("acme-libs")].join());
      assert.strictEqual(s.filter.author, "dana", "Author kept");
      await vscode.commands.executeCommand("polylog._itest.answer", "web");
      await vscode.commands.executeCommand("polylog.profileSwitch");
      await until("web ticked", (x) => x.filter.repoIds?.join() === id("acme-web"));
      await vscode.commands.executeCommand("polylog._itest.answer", "All repositories");
      await vscode.commands.executeCommand("polylog.profileSwitch");
      await until("All again", (x) => x.filter.repoIds === null);
    } finally {
      await vscode.commands.executeCommand("polylog._itest.answer", undefined);
      await cfg.update("profiles", undefined, vscode.ConfigurationTarget.Workspace);
      await send({ type: "filter", filter: ALL });
    }
    await until("no profiles", (x) => x.profiles.length === 0);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run typecheck`
Expected: FAIL — `Property 'profiles' does not exist on type 'LogSnapshot'`.

- [ ] **Step 3: Contribute the setting and the two commands**

In `package.json` → `contributes.configuration.properties`, after `"polylog.excludeRepos"`, add:

```json
        "polylog.profiles": {
          "type": "object",
          "scope": "window",
          "default": {},
          "additionalProperties": { "type": "array", "items": { "type": "string" } },
          "markdownDescription": "Named groups of repositories for the Repo List, e.g. `{ \"backend\": [\"acme-api\", \"acme-libs\"] }`. Each repository is its path relative to the workspace folder (`.` for the folder itself; in a multi-root workspace, the folder's name first). Saved from the Repo List; clicking a profile ticks its repositories and changes no other filter."
        },
```

In `contributes.commands`, after `polylog.repoCopyPath`, add:

```json
      { "command": "polylog.profileSwitch", "title": "Switch Profile…", "category": "Polylog" },
      { "command": "polylog.profileShow", "title": "Show This Profile", "category": "Polylog" },
```

In `menus.commandPalette` add `{ "command": "polylog.profileShow", "when": "false" }` (Switch stays visible).
In `menus.view/title` add `{ "command": "polylog.profileSwitch", "when": "view == polylog.log", "group": "2_profile@1" }`.
In `menus.webview/context` add `{ "command": "polylog.profileShow", "when": "webviewId == 'polylog.log' && webviewSection == 'profile'", "group": "0_profile@1" }`.

- [ ] **Step 4: Extend `Ask`**

In `src/uncommittedView.ts`, replace the `input` method of `Ask` and add two methods after it:

```ts
  async input(prompt: string, placeHolder: string, opts: { value?: string; validate?: (v: string) => string | vscode.InputBoxValidationMessage | undefined } = {}): Promise<string | undefined> {
    this.asked++;
    if (this.testing && this.answers.length > 0) {
      const a = this.answers.shift();
      return a === "Cancel" ? undefined : a;
    }
    return vscode.window.showInputBox({ prompt, placeHolder, value: opts.value, validateInput: opts.validate, ignoreFocusOut: true });
  }

  /** One item; its index. Testing: the queued answer is the item's label. */
  async pick(items: readonly vscode.QuickPickItem[], placeHolder: string): Promise<number | undefined> {
    this.asked++;
    if (this.testing && this.answers.length > 0) {
      const answer = this.answers.shift();
      const i = items.findIndex((x) => x.label === answer);
      return i < 0 ? undefined : i;
    }
    const chosen = await vscode.window.showQuickPick([...items], { placeHolder });
    return chosen ? items.indexOf(chosen) : undefined;
  }

  /** Ticked items (those with `picked` start ticked); their indexes. Testing: a JSON array of labels. */
  async pickMany(items: readonly vscode.QuickPickItem[], placeHolder: string): Promise<number[] | undefined> {
    this.asked++;
    if (this.testing && this.answers.length > 0) {
      const a = this.answers.shift();
      if (a === undefined || a === "Cancel") return undefined;
      const labels = JSON.parse(a) as string[];
      return items.flatMap((x, i) => (labels.includes(x.label) ? [i] : []));
    }
    const chosen = await vscode.window.showQuickPick([...items], { placeHolder, canPickMany: true });
    return chosen ? chosen.map((c) => items.indexOf(c)) : undefined;
  }
```

Share one `Ask` between the views: in `UncommittedViewDeps` add `ask: Ask;`, change the field `readonly ask = new Ask();` to `readonly ask: Ask;`, and as the first line of the `UncommittedView` constructor body add `this.ask = deps.ask;`.

- [ ] **Step 5: Post and switch profiles from `LogView`**

In `src/protocol.ts`, import the type and extend `init`:

```ts
import type { ResolvedProfile } from "./profileModel";
```

```ts
  | { type: "init"; repos: Repo[]; filter: FilterState; hasMe: boolean; layout: Layout; history: { repoName: string; path: string } | null; logMode?: "commits" | "uncommitted"; profiles: ResolvedProfile[] }
```

In `src/logView.ts`:
- import: `import { activeProfiles, profileFilter, readProfiles, repoKey, resolveProfiles, type Profiles, type ResolvedProfile } from "./profileModel";` and `import type { Ask } from "./uncommittedView";` (merge with the existing `uncommittedView` import).
- `LogDeps` gains `ask: Ask;`.
- `LogSnapshot` gains `profiles: ResolvedProfile[];` and `snapshot()` returns `profiles: this.resolvedProfiles(),` beside `repos`.
- `postInit` adds `profiles: this.resolvedProfiles()` to the posted object (before the `...(forceMode …)` spread).
- Add, after `setRepoFilter`:

```ts
  /** polylog.profiles as written (lenient: malformed entries are skipped). */
  private rawProfiles(): Profiles {
    return readProfiles(vscode.workspace.getConfiguration("polylog").get("profiles"));
  }

  /** How each repository is named in polylog.profiles. */
  private profileKeys(): { id: string; key: string }[] {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
    return this.repos.map((r) => ({ id: r.id, key: repoKey(r.root, folders, process.platform === "win32") }));
  }

  resolvedProfiles(): ResolvedProfile[] {
    return resolveProfiles(this.rawProfiles(), this.profileKeys());
  }

  /** polylog.profiles changed (by Polylog or by hand): redraw the Repo List. */
  profilesChanged(): void {
    this.postInit();
  }

  /** The profile a right-click was on. */
  private contextProfile(arg: unknown): ResolvedProfile | undefined {
    const name = (arg as { profile?: unknown } | undefined)?.profile;
    return typeof name === "string" ? this.resolvedProfiles().find((p) => p.name === name) : undefined;
  }

  /** Right-click a profile → Show This Profile (the same as clicking it). */
  async profileShow(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    if (p) await this.setRepoFilter(profileFilter(p, this.repos.map((r) => r.id)));
  }

  /** ⋯ → Switch Profile…: All repositories, then each profile; works with the Repo List hidden. */
  async profileSwitch(): Promise<void> {
    const all = this.repos.map((r) => r.id);
    const resolved = this.resolvedProfiles();
    const active = activeProfiles(resolved, this.filter.repoIds, all);
    const nameOf = new Map(this.repos.map((r) => [r.id, r.name]));
    const items: vscode.QuickPickItem[] = [
      { label: "All repositories", description: `${all.length} repositories`, detail: this.filter.repoIds === null ? "Current" : undefined },
      ...resolved.map((p) => ({ label: p.name, description: p.ids.map((id) => nameOf.get(id)).join(", ") || "no repository found", detail: active.includes(p.name) ? "Current" : undefined })),
    ];
    const i = await this.deps.ask.pick(items, resolved.length > 0 ? "Switch profile" : "No profiles yet: tick some repositories, then Save Selection as Profile…");
    if (i === undefined) return;
    await this.setRepoFilter(i === 0 ? null : profileFilter(resolved[i - 1], all));
  }
```

- [ ] **Step 6: Wire it in `src/extension.ts`**

- Import `Ask` with `UncommittedView` from `./uncommittedView`.
- Before `const log: LogView = new LogView(...)`, add `const ask = new Ask();` and pass `ask` in the `LogView` deps object: `{ discovery, run: git.run, changes, uncommitted, ask }`.
- Pass `ask` in the `UncommittedView` deps object.
- In the existing `vscode.workspace.onDidChangeConfiguration` listener add `if (e.affectsConfiguration("polylog.profiles")) log.profilesChanged();`.
- Register: `vscode.commands.registerCommand("polylog.profileSwitch", () => log.profileSwitch()),` and `vscode.commands.registerCommand("polylog.profileShow", (arg?: unknown) => log.profileShow(arg)),`.

In `dev/harness/shim.ts`, both mock `init` messages (the `case "ready"` and the `case "exitHistory"` lines) gain:

```ts
profiles: [{ name: "backend", ids: ["/work/acme-api", "/work/acme-libs"], missing: ["acme-jobs"] }]
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `npm run typecheck && npm run lint && npm test && npm run test:integration 2>&1 | grep -E "passing|failing|  [0-9]+\) "`
Expected: typecheck clean, lint 0 errors, unit exit 0, integration all passing (75), including "profiles: read from polylog.profiles…".

- [ ] **Step 8: Commit**

```bash
git add package.json src/protocol.ts src/uncommittedView.ts src/logView.ts src/extension.ts dev/harness/shim.ts src/integration/log.itest.ts
git commit -F - <<'EOF'
feat(profiles): read polylog.profiles, post them with init, Show and Switch Profile…

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Save, Update, Rename, Delete and a repository's Profiles…

**Files:**
- Modify: `src/logView.ts` (the edit commands and `writeProfiles`)
- Modify: `src/extension.ts` (register five commands)
- Modify: `src/protocol.ts` (`WebviewMessage` `{ type: "profileSave" }`)
- Modify: `package.json` (commands, menus, palette)
- Test: `src/integration/log.itest.ts`

**Interfaces:**
- Consumes (Task 1): `nameProblem`, `profileNames`, `saveProfile`, `renameProfile`, `deleteProfile`, `setMembership`. (Task 2): `rawProfiles`, `profileKeys`, `contextProfile`, `deps.ask`, `postInit`, `contextRepo` (existing).
- Produces: `LogView.profileSave()`, `profileUpdate(arg)`, `profileRename(arg)`, `profileDelete(arg)`, `repoProfiles(arg)` (all `Promise<void>`); commands `polylog.profileSave` "Save Selection as Profile…", `polylog.profileUpdate` "Update to Current Selection", `polylog.profileRename` "Rename…", `polylog.profileDelete` "Delete", `polylog.repoProfiles` "Profiles…"; webview message `{ type: "profileSave" }`; webview contexts `{ webviewSection: "profile", profile, updatable: boolean }` and `{ webviewSection: "repoList" }` (drawn in Task 4).

- [ ] **Step 1: Write the failing integration test**

In `src/integration/log.itest.ts`, after the Task 2 test, add:

```ts
  it("profiles: save the ticks, a repository's Profiles…, update, rename (refuses a taken name), delete asks", async () => {
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const id = (name: string) => s0.repos.find((r) => r.name === name)!.id;
    const cfg = vscode.workspace.getConfiguration("polylog");
    const saved = () => cfg.inspect<Record<string, string[]>>("profiles")?.workspaceValue;
    const answer = (v: string | undefined) => vscode.commands.executeCommand("polylog._itest.answer", v);
    try {
      await send({ type: "filter", filter: { ...ALL, repoIds: [id("acme-api"), id("acme-libs")] } });
      await answer("backend");
      await vscode.commands.executeCommand("polylog.profileSave");
      await waitFor("backend saved", () => (saved()?.backend?.join() === "acme-api,acme-libs" ? true : undefined));
      await until("backend resolved", (x) => x.profiles.some((p) => p.name === "backend"));
      // A repository's Profiles…: add acme-web to backend and make a new profile with it.
      await answer(JSON.stringify(["backend", "New profile with acme-web…"]));
      await answer("web");
      await vscode.commands.executeCommand("polylog.repoProfiles", { webviewSection: "repo", repoId: id("acme-web") });
      await waitFor("memberships", () => (saved()?.backend?.join() === "acme-api,acme-libs,acme-web" && saved()?.web?.join() === "acme-web" ? true : undefined));
      // ...and take it out again: unticked = removed.
      await answer(JSON.stringify([]));
      await vscode.commands.executeCommand("polylog.repoProfiles", { webviewSection: "repo", repoId: id("acme-web") });
      await waitFor("removed", () => (saved()?.backend?.join() === "acme-api,acme-libs" && saved()?.web?.length === 0 ? true : undefined));
      // Update to Current Selection.
      await send({ type: "filter", filter: { ...ALL, repoIds: [id("acme-api")] } });
      await vscode.commands.executeCommand("polylog.profileUpdate", { webviewSection: "profile", profile: "backend" });
      await waitFor("updated", () => (saved()?.backend?.join() === "acme-api" ? true : undefined));
      // Rename to a taken name (any case) changes nothing; to a free one, renames.
      await answer("WEB");
      await vscode.commands.executeCommand("polylog.profileRename", { webviewSection: "profile", profile: "backend" });
      assert.ok(saved()?.backend && !saved()?.WEB, "a taken name is refused");
      await answer("api");
      await vscode.commands.executeCommand("polylog.profileRename", { webviewSection: "profile", profile: "backend" });
      await waitFor("renamed", () => (saved()?.api?.join() === "acme-api" && !saved()?.backend ? true : undefined));
      // Delete asks; Cancel keeps it.
      await answer("Cancel");
      await vscode.commands.executeCommand("polylog.profileDelete", { webviewSection: "profile", profile: "api" });
      assert.ok(saved()?.api, "Cancel keeps it");
      await answer("Delete");
      await vscode.commands.executeCommand("polylog.profileDelete", { webviewSection: "profile", profile: "api" });
      await waitFor("deleted", () => (saved()?.api === undefined ? true : undefined));
      assert.strictEqual(await vscode.commands.executeCommand("polylog._itest.lastWarning"), 'Delete profile "api"?');
    } finally {
      await answer(undefined);
      await cfg.update("profiles", undefined, vscode.ConfigurationTarget.Workspace);
      await send({ type: "filter", filter: ALL });
    }
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run test:integration 2>&1 | grep -E "passing|failing|  [0-9]+\) "`
Expected: FAIL on the new test — `timed out waiting for backend saved` (the command does not exist yet).

- [ ] **Step 3: Write the commands**

In `src/logView.ts`, extend the `profileModel` import with `deleteProfile, nameProblem, profileNames, renameProfile, saveProfile, setMembership`, and add after `profileSwitch`:

```ts
  /** Writes polylog.profiles to the workspace settings; false (with an error shown) if it could not. */
  private async writeProfiles(next: Profiles): Promise<boolean> {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showErrorMessage("Polylog: profiles are saved in the workspace settings; open a folder first.");
      return false;
    }
    try {
      await vscode.workspace.getConfiguration("polylog").update("profiles", next, vscode.ConfigurationTarget.Workspace);
    } catch (e) {
      void vscode.window.showErrorMessage(`Polylog could not save the profile: ${messageOf(e)}`);
      return false;
    }
    this.postInit();
    return true;
  }

  /** The ticked repositories as profile entries. */
  private tickedKeys(): string[] {
    const keyOf = new Map(this.profileKeys().map((k) => [k.id, k.key]));
    return (this.filter.repoIds ?? this.repos.map((r) => r.id)).flatMap((id) => keyOf.get(id) ?? []);
  }

  /** ＋ Save as profile…, the Repo List's right-click, ⋯: the ticked repositories under a name. */
  async profileSave(): Promise<void> {
    const keys = this.tickedKeys();
    if (keys.length === 0) return;
    const current = this.rawProfiles();
    const n = keys.length === 1 ? "1 repository" : `${keys.length} repositories`;
    const name = await this.deps.ask.input(`Name for a profile of ${n}`, "backend", {
      validate: (v) => {
        if (!v.trim()) return undefined;
        const taken = Object.keys(current).find((k) => k.toLowerCase() === v.trim().toLowerCase());
        return taken === undefined ? undefined : { message: `"${taken}" exists: Enter replaces it with these ${n}.`, severity: vscode.InputBoxValidationSeverity.Warning };
      },
    });
    if (!name?.trim()) return;
    // Replacing keeps the existing spelling of the name.
    const taken = Object.keys(current).find((k) => k.toLowerCase() === name.trim().toLowerCase());
    await this.writeProfiles(saveProfile(current, taken ?? name, keys));
  }

  /** Right-click a profile → Update to Current Selection. */
  async profileUpdate(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    const keys = this.tickedKeys();
    if (p && keys.length > 0) await this.writeProfiles(saveProfile(this.rawProfiles(), p.name, keys));
  }

  /** Right-click a profile → Rename…: refuses a name that is taken (in any case). */
  async profileRename(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    if (!p) return;
    const current = this.rawProfiles();
    const name = await this.deps.ask.input(`New name for profile "${p.name}"`, p.name, { value: p.name, validate: (v) => nameProblem(current, v, p.name) });
    if (name === undefined || nameProblem(current, name, p.name) !== undefined || name.trim() === p.name) return;
    await this.writeProfiles(renameProfile(current, p.name, name));
  }

  /** Right-click a profile → Delete: asks; the repositories stay as they are. */
  async profileDelete(arg: unknown): Promise<void> {
    const p = this.contextProfile(arg);
    if (!p) return;
    if (!(await this.deps.ask.warning(`Delete profile "${p.name}"?`, "Its repositories stay as they are; only the name goes.", "Delete"))) return;
    await this.writeProfiles(deleteProfile(this.rawProfiles(), p.name));
  }

  /** Right-click a repository → Profiles…: tick the profiles it belongs to, or start a new one with it. */
  async repoProfiles(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (!repo) return;
    const key = this.profileKeys().find((k) => k.id === repo.id)?.key;
    if (!key) return;
    const current = this.rawProfiles();
    const names = profileNames(current);
    const items: vscode.QuickPickItem[] = [
      ...names.map((n) => ({ label: n, description: current[n].length === 1 ? "1 repository" : `${current[n].length} repositories`, picked: current[n].includes(key) })),
      { label: `New profile with ${repo.name}…`, picked: false },
    ];
    const chosen = await this.deps.ask.pickMany(items, `Profiles with ${repo.name}`);
    if (chosen === undefined) return;
    let next = setMembership(current, key, chosen.filter((i) => i < names.length).map((i) => names[i]));
    if (chosen.includes(names.length)) {
      const name = await this.deps.ask.input(`Name for a new profile with ${repo.name}`, "backend", { validate: (v) => (v.trim() ? nameProblem(next, v) : undefined) });
      if (name !== undefined && nameProblem(next, name) === undefined) next = saveProfile(next, name, [key]);
    }
    await this.writeProfiles(next);
  }
```

In `onMessage`, add a case (the webview's ＋ row):

```ts
      case "profileSave":
        await this.profileSave();
        return;
```

In `src/protocol.ts` `WebviewMessage` add `| { type: "profileSave" }`.

In `src/extension.ts` register:

```ts
    vscode.commands.registerCommand("polylog.profileSave", () => log.profileSave()),
    vscode.commands.registerCommand("polylog.profileUpdate", (arg?: unknown) => log.profileUpdate(arg)),
    vscode.commands.registerCommand("polylog.profileRename", (arg?: unknown) => log.profileRename(arg)),
    vscode.commands.registerCommand("polylog.profileDelete", (arg?: unknown) => log.profileDelete(arg)),
    vscode.commands.registerCommand("polylog.repoProfiles", (arg?: unknown) => log.repoProfiles(arg)),
```

- [ ] **Step 4: Menus**

In `package.json`:
- `contributes.commands` after `polylog.profileShow`:

```json
      { "command": "polylog.profileSave", "title": "Save Selection as Profile…", "category": "Polylog" },
      { "command": "polylog.profileUpdate", "title": "Update to Current Selection", "category": "Polylog" },
      { "command": "polylog.profileRename", "title": "Rename…", "category": "Polylog" },
      { "command": "polylog.profileDelete", "title": "Delete", "category": "Polylog" },
      { "command": "polylog.repoProfiles", "title": "Profiles…", "category": "Polylog" },
```

- `menus.commandPalette`: `{ "command": "polylog.profileUpdate", "when": "false" }`, the same for `profileRename`, `profileDelete`, `repoProfiles` (Save stays visible).
- `menus.view/title`: `{ "command": "polylog.profileSave", "when": "view == polylog.log", "group": "2_profile@2" }`.
- `menus.webview/context`:

```json
        { "command": "polylog.profileUpdate", "when": "webviewId == 'polylog.log' && webviewSection == 'profile' && updatable", "group": "1_profileEdit@1" },
        { "command": "polylog.profileRename", "when": "webviewId == 'polylog.log' && webviewSection == 'profile'", "group": "1_profileEdit@2" },
        { "command": "polylog.profileDelete", "when": "webviewId == 'polylog.log' && webviewSection == 'profile'", "group": "1_profileEdit@3" },
        { "command": "polylog.profileSave", "when": "webviewId == 'polylog.log' && webviewSection =~ /^(repoList|repo|profile)$/", "group": "9_profile@1" },
        { "command": "polylog.repoProfiles", "when": "webviewId == 'polylog.log' && webviewSection =~ /^(repo|commit|uncommitted)$/", "group": "9_profile@2" },
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npm run typecheck && npm run lint && npm test && npm run test:integration 2>&1 | grep -E "passing|failing|  [0-9]+\) "`
Expected: all passing (76).

- [ ] **Step 6: Commit**

```bash
git add src/logView.ts src/extension.ts src/protocol.ts package.json src/integration/log.itest.ts
git commit -F - <<'EOF'
feat(profiles): Save Selection as Profile…, Update, Rename, Delete, and a repository's Profiles…

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Profile rows and the ＋ Save as profile… row in the Repo List

**Files:**
- Modify: `src/webview/repoPane.ts`
- Modify: `src/webview/main.ts`
- Modify: `src/webview/styles.css`
- Test: `src/webview/repoPaneModel.ts` + `src/webview/repoPaneModel.test.ts` (row composition, pure)

**Interfaces:**
- Consumes (Task 1): `activeProfiles`, `showSaveRow`, `profileFilter`, `ResolvedProfile`. (Task 2): `init.profiles`. (Task 3): message `{ type: "profileSave" }`, context sections `profile` (with `updatable`) and `repoList`.
- Produces: `paneRows(repos: readonly Repo[], query: string, profiles: readonly ResolvedProfile[], repoIds: readonly string[] | null): PaneRow[]` in `repoPaneModel.ts`, where `type PaneRow = { kind: "all" } | { kind: "profile"; profile: ResolvedProfile; active: boolean } | { kind: "save"; count: number } | { kind: "repo"; id: string; name: string }`; `RepoPane.update(repos, repoIds, profiles)`; `RepoPane` constructor `(onChange: (repoIds: string[] | null) => void, onSave: () => void)`.

- [ ] **Step 1: Write the failing test**

Append to `src/webview/repoPaneModel.test.ts` (it is already in `test:unit`):

```ts
{
  const repos = [{ id: "/ws/acme-web", name: "acme-web", root: "/ws/acme-web" }, { id: "/ws/acme-api", name: "acme-api", root: "/ws/acme-api" }, { id: "/ws/acme-libs", name: "acme-libs", root: "/ws/acme-libs" }];
  const backend = { name: "backend", ids: ["/ws/acme-api", "/ws/acme-libs"], missing: [] };
  const kinds = (rows: PaneRow[]) => rows.map((r) => (r.kind === "profile" ? `profile:${r.profile.name}${r.active ? "*" : ""}` : r.kind === "save" ? `save:${r.count}` : r.kind === "repo" ? r.name : "all"));
  assert.deepStrictEqual(kinds(paneRows(repos, "", [backend], null)), ["all", "profile:backend", "acme-web", "acme-api", "acme-libs"]);
  assert.deepStrictEqual(kinds(paneRows(repos, "", [backend], backend.ids)), ["all", "profile:backend*", "acme-web", "acme-api", "acme-libs"], "active: the ticks are the profile");
  assert.deepStrictEqual(kinds(paneRows(repos, "", [backend], ["/ws/acme-web"])), ["all", "profile:backend", "save:1", "acme-web", "acme-api", "acme-libs"], "a new selection can be saved");
  assert.deepStrictEqual(kinds(paneRows(repos, "", [], ["/ws/acme-web"])), ["all", "save:1", "acme-web", "acme-api", "acme-libs"], "the way in with no profiles yet");
  assert.deepStrictEqual(kinds(paneRows(repos, "api", [backend], ["/ws/acme-web"])), ["all", "acme-api"], "searching repositories hides profiles");
  console.log("ok - paneRows: All, profiles, the save row, repositories");
}
```

and add `paneRows, type PaneRow` to that file's import from `./repoPaneModel`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx esbuild src/webview/repoPaneModel.test.ts --bundle --platform=node --format=cjs --outfile=out/repoPaneModel.test.cjs --log-level=error`
Expected: FAIL — `No matching export in "src/webview/repoPaneModel.ts" for import "paneRows"`.

- [ ] **Step 3: Write `paneRows`**

In `src/webview/repoPaneModel.ts`, add (with `import type { Repo } from "../types";` if not imported, and `import { activeProfiles, showSaveRow, type ResolvedProfile } from "../profileModel";`):

```ts
export type PaneRow =
  | { kind: "all" }
  | { kind: "profile"; profile: ResolvedProfile; active: boolean }
  | { kind: "save"; count: number }
  | { kind: "repo"; id: string; name: string };

/**
 * The Repo List's rows: All, the profiles and the ＋ Save as profile… row (not while searching
 * repositories by name: the search is for repositories), then the repositories.
 */
export function paneRows(repos: readonly Repo[], query: string, profiles: readonly ResolvedProfile[], repoIds: readonly string[] | null): PaneRow[] {
  const repoRows: PaneRow[] = visibleRepos(repos, query).map((r) => ({ kind: "repo", id: r.id, name: r.name }));
  if (query.trim()) return [{ kind: "all" }, ...repoRows];
  const allIds = repos.map((r) => r.id);
  const active = activeProfiles(profiles, repoIds, allIds);
  const rows: PaneRow[] = [{ kind: "all" }, ...profiles.map((profile): PaneRow => ({ kind: "profile", profile, active: active.includes(profile.name) }))];
  if (showSaveRow(profiles, repoIds, allIds)) rows.push({ kind: "save", count: repoIds!.length });
  return [...rows, ...repoRows];
}
```

(`visibleRepos<T extends { name: string }>(repos: readonly T[], query: string): T[]` is the existing function in this file.)

Run: `npx esbuild src/webview/repoPaneModel.test.ts --bundle --platform=node --format=cjs --outfile=out/repoPaneModel.test.cjs --log-level=error && node out/repoPaneModel.test.cjs`
Expected: PASS, including `ok - paneRows: …`.

- [ ] **Step 4: Draw the rows in `RepoPane`**

In `src/webview/repoPane.ts`:
- Replace `interface Row { id: string | null; name: string }` with use of `PaneRow` (import it and `profileFilter`, `ResolvedProfile`); `private rows: PaneRow[] = [];`; add `private profiles: readonly ResolvedProfile[] = [];`.
- Constructor becomes `constructor(private readonly onChange: (repoIds: string[] | null) => void, private readonly onSave: () => void)`, and after the existing listeners add the Repo List's own context (empty area → Save Selection as Profile…):

```ts
    this.list.dataset.vscodeContext = JSON.stringify({ webviewSection: "repoList", preventDefaultContextMenuItems: true });
```

- `update(repos, repoIds, profiles: readonly ResolvedProfile[] = [])`: include `JSON.stringify(profiles)` in the change key (rebuild when profiles change) and store `this.profiles = profiles`.
- `activate(i, toggle)`:

```ts
    const row = this.rows[i];
    if (!row) return;
    const allIds = this.repos.map((r) => r.id);
    this.idsKey = undefined;
    if (row.kind === "all") this.onChange(null);
    else if (row.kind === "profile") this.onChange(profileFilter(row.profile, allIds));
    else if (row.kind === "save") this.onSave();
    else this.onChange(toggle ? toggleRepo(this.repoIds, row.id, allIds) : pickOnly(row.id));
```

- `render()`: `this.rows = paneRows(this.repos, this.filterInput.value, this.profiles, this.repoIds);` and draw each kind. Keep the existing `all` and `repo` markup (with `row.id === null` → `row.kind === "all"`, `row.id`/`row.name` from the repo row). Draw the new kinds with:

```ts
      if (row.kind === "profile") {
        const p = row.profile;
        const names = p.ids.map((id) => this.repos.find((r) => r.id === id)?.name ?? id).join(", ");
        const missing = p.missing.length > 0 ? `\n${p.missing.length} not in this workspace: ${p.missing.join(", ")} (skipped)` : "";
        this.list.append(h("div", {
          class: `${i === this.active ? "repo-row active" : "repo-row"} profile-row${row.active ? " current" : ""}`,
          role: "option", id: `repo-row-${i}`, "aria-selected": String(row.active), "data-row": String(i),
          title: `${p.name}: ${names || "no repository found"}${missing}`,
          "aria-label": `Profile ${p.name}, ${p.ids.length} repositories${p.missing.length ? `, ${p.missing.length} not found` : ""}`,
          "data-vscode-context": JSON.stringify({ webviewSection: "profile", profile: p.name, updatable: !(row.active && p.missing.length === 0), preventDefaultContextMenuItems: true }),
        }, [
          h("span", { class: "profile-icon", "aria-hidden": "true" }),
          h("span", { class: "repo-name" }, [p.name]),
          p.missing.length > 0 ? h("span", { class: "profile-missing", "aria-hidden": "true" }, ["⚠"]) : null,
          h("span", { class: "repo-count" }, [String(p.ids.length)]),
        ]));
        return;
      }
      if (row.kind === "save") {
        this.list.append(h("div", {
          class: `${i === this.active ? "repo-row active" : "repo-row"} save-row`,
          role: "option", id: `repo-row-${i}`, "aria-selected": "false", "data-row": String(i),
          title: "Save the ticked repositories as a profile",
          "aria-label": `Save ${row.count} ticked repositories as a profile`,
          "data-vscode-context": JSON.stringify({ webviewSection: "repoList", preventDefaultContextMenuItems: true }),
        }, [h("span", { class: "save-icon", "aria-hidden": "true" }, ["+"]), h("span", { class: "repo-name" }, ["Save as profile…"]), h("span", { class: "repo-count" }, [String(row.count)])]));
        return;
      }
```

  Put a divider after the last non-repository row: when `row.kind === "repo"` and the previous row is not a repo row, append `h("div", { class: "repo-divider", role: "presentation" })` first. The "All repositories" row's context becomes `{ webviewSection: "repoList", preventDefaultContextMenuItems: true }`.
- `onKey` Enter on Search (`this.active = 1; this.activate(1, false)`) still picks the best repository: while searching, row 1 is a repository (`paneRows` hides profiles), so no change is needed.

In `src/webview/main.ts`:
- `state` gains `profiles: [] as ResolvedProfile[]` (import the type from `../profileModel`).
- `new RepoPane((repoIds) => setFilter({ ...state.filter, repoIds }), () => post({ type: "profileSave" }))`.
- In `case "init"`: `state.profiles = m.profiles;` and `repoPane.update(m.repos, m.filter.repoIds, m.profiles);`.
- In `setFilter`: `repoPane.update(state.repos, f.repoIds, state.profiles);`.

In `src/webview/styles.css`, after the `.repo-dot.all` rule:

```css
/* Profiles: a small list glyph drawn with the text color (no icon font). */
.profile-icon { width: 10px; height: 9px; flex: none; background: linear-gradient(currentColor 0 0) 0 0 / 100% 1px no-repeat, linear-gradient(currentColor 0 0) 0 4px / 100% 1px no-repeat, linear-gradient(currentColor 0 0) 0 8px / 100% 1px no-repeat; opacity: .8; }
.profile-row.current { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, inherit); }
.profile-missing { color: var(--vscode-editorWarning-foreground); }
.save-row { color: var(--vscode-descriptionForeground); }
.save-row:hover { color: var(--vscode-foreground); }
.save-icon { width: 10px; text-align: center; flex: none; }
.repo-divider { border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); margin: 4px 10px; }
body.vscode-high-contrast .profile-row.current { outline: 1px dashed var(--vscode-contrastActiveBorder); outline-offset: -1px; }
```

- [ ] **Step 5: Check it**

Run: `npm run typecheck && npm run lint && npm test && npm run check:theme && npm run check:design`
Expected: all pass (theme tokens clean: no hex). Then open the dev harness (`npm run harness`) and check in dark, light and high contrast: the backend row, its highlight after clicking it, the ＋ row after unticking a repository, and the divider.

Run: `npm run test:integration 2>&1 | grep -E "passing|failing"` — all passing.

- [ ] **Step 6: Commit**

```bash
git add src/webview/repoPane.ts src/webview/repoPaneModel.ts src/webview/repoPaneModel.test.ts src/webview/main.ts src/webview/styles.css
git commit -F - <<'EOF'
feat(profiles): profile rows and the ＋ Save as profile… row in the Repo List

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Docs and the UI Map

**Files:**
- Modify: `README.md` (the Repo List section)
- Modify: `dev/ui-map/index.html` (glossary entries; the mock's Repo List)

**Interfaces:** none (docs).

- [ ] **Step 1: README**

Under the README's Repo List / Repositories pane bullet, add:

```markdown
  - **Profiles.** Save the ticked repositories under a name (**＋ Save as profile…** appears
    as soon as you pick some, or right-click the Repo List), then click the profile to tick
    exactly those repositories again. Your other filters stay as they are. Profiles live in
    the workspace setting `polylog.profiles`, one list of repository paths per name, so you
    can edit them by hand or share them. Right-click a repository for **Profiles…**, a
    profile for **Update to Current Selection**, **Rename…** and **Delete**; **⋯ → Switch
    Profile…** works with the Repo List hidden.
```

- [ ] **Step 2: UI Map**

In `dev/ui-map/index.html`, in the mock Repo List add a profile row (`backend · 2`) and the save row under "All repositories", each with a named region (`class="… t"` and `<i class="n tl">N</i>`), and add glossary entries in page order:

```html
<div class="g"><i class="num">N</i><b>Profile row</b><span>A saved group of repositories (polylog.profiles). Click: tick exactly them; highlighted while the ticks are that profile. ⚠ when some are not in this workspace. Right-click: Show, Update to Current Selection, Rename…, Delete.</span></div>
<div class="g"><i class="num">N+1</i><b>Save as profile row</b><span>"＋ Save as profile…": shown while the ticked repositories are neither All nor a profile. Click to name them.</span></div>
```

Renumber the following entries. Run `npm run check:denylist` (expected: clean) and open `npm run ui-map` once to check every new box has its number.

- [ ] **Step 3: Commit**

```bash
git add README.md dev/ui-map/index.html
git commit -F - <<'EOF'
docs: Repo List profiles in the README and the UI Map

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```
