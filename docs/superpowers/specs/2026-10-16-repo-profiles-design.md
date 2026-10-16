# Repo List profiles — design

Status: approved in brainstorming (2026-10-16); demo reviewed on the brainstorm companion.

## Goal

Let the maintainer name a group of repositories ("backend", "frontend") and switch the Log to
it in one click, instead of re-ticking the same repositories in the Repo List every time.

**Success:** with profiles saved, clicking one ticks exactly its repositories; the Log reruns
on that set; every other filter (Search, Author, Branch, Date, Path) is untouched.

## Decisions (from the brainstorm)

| Question | Decision | Why |
|---|---|---|
| What a profile saves | **Repositories only** | Groups, not saved searches: switching never wipes a search in progress. |
| How a repository belongs | **A picked list** | Predictable; no pattern language. A repository cloned later joins by one action. |
| Where profiles live | **Workspace setting `polylog.profiles`** | Readable, hand-editable, survives reinstalls, shareable if the file is committed. |
| More than one at once | **One at a time** | The active profile's name is always the whole truth. Unions are made by ticking, or saved as their own profile. |
| Where the picker is | **Rows at the top of the Repo List** (approach A) | Beside "All repositories", which already is a profile in all but name; no fifth box in the Filter bar. |

Out of scope: patterns, saving other filters, combining profiles, per-user or global profiles,
profiles in the Compare tab's Repositories list (it follows the Log's ticks already).

## The setting

```jsonc
// .vscode/settings.json (or the .code-workspace file in a multi-root workspace)
"polylog.profiles": {
  "backend": ["acme-api", "acme-billing", "acme-libs"],
  "frontend": ["acme-web", "acme-admin", "acme-libs"]
}
```

- Contributed with `"scope": "window"` and written with `ConfigurationTarget.Workspace`.
- **Keys** are profile names: trimmed, non-empty, unique; shown sorted (case-insensitive).
- **Entries** name each repository by its path relative to the workspace folder that contains
  it, with `/` separators (`services/acme-api`), never an absolute path: a shared file must work
  on every machine. The workspace folder itself is `"."`. In a multi-root workspace the entry is
  prefixed with the folder's name, as `vscode.workspace.asRelativePath(root, true)` does.
- Polylog reads entries leniently: a non-object value, a non-array list or a non-string entry
  is ignored (never an error). Duplicates count once.
- **An entry that matches no repository** (not cloned here, excluded by `polylog.excludeRepos`,
  beyond `polylog.scanDepth`) is kept in the setting, skipped when ticking, and listed in the
  profile row's tooltip with a ⚠: "1 not in this workspace: acme-jobs (skipped)". Its count
  shows only the repositories found.
- A hand edit of the setting re-renders the Repo List (`onDidChangeConfiguration`).

## The Repo List

Order: Repo search, **All repositories**, the profile rows, the **＋ Save as profile…** row
(when shown), a divider, the repository rows.

- **Profile row:** an icon, the name, ⚠ when some entries are missing, the count of
  repositories found. Click: tick exactly those repositories (all other filters stay). A
  profile with no repository found ticks none: the Log shows its usual "no repositories ticked"
  state.
- **Active profile is derived, never stored.** A profile row is highlighted while the ticked
  set equals its found set; "All repositories" while nothing is filtered (`repoIds === null`).
  Tick or untick anything and the highlight follows the ticks. If two profiles resolve to the
  same set, both highlight.
- **＋ Save as profile… row** (the way in, also with no profiles yet): shown while the ticks are
  neither All nor any profile's set, and at least one repository is ticked. Count = ticked
  repositories. Click: Save Selection as Profile… (below).
- Keyboard: profile rows and the save row are rows like the others (↑/↓, Enter, Space as on
  "All repositories").

## Commands and menus

| Command | Where | Does |
|---|---|---|
| `polylog.profileSave` — Save Selection as Profile… | ＋ row; Repo List right-click (empty area and repository rows); Log toolbar ⋯ | Input box for a name. A name that exists warns inline ("Enter replaces it with these N repositories") and Enter replaces it. |
| `polylog.profileSwitch` — Switch Profile… | Log toolbar ⋯; Command Palette | Quick pick: All repositories, then each profile (description: its repositories; "current" on the active one). Works with the Repo List hidden. |
| `polylog.profileShow` — Show This Profile | Profile row right-click | Same as clicking it. |
| `polylog.profileUpdate` — Update to Current Selection | Profile row right-click | Replaces its list with the ticked repositories. Hidden when they already match and nothing is missing. |
| `polylog.profileRename` — Rename… | Profile row right-click | Input box, prefilled; refuses an existing name. |
| `polylog.profileDelete` — Delete | Profile row right-click | Modal confirm "Delete profile "backend"?" — "Its repositories stay as they are; only the name goes." |
| `polylog.repoProfiles` — Profiles… | Repository row right-click (Repo List; also the Log's commit and Uncommitted rows, where the Repo menu is) | Multi-select quick pick of every profile, this repository's memberships pre-ticked, plus "New profile with acme-api…". Accepting applies the ticks. |

VS Code menus are static, so per-profile submenus ("Add to Profile ▸ backend") cannot exist;
`Profiles…` replaces them. Profile rows carry `data-vscode-context`
`{ webviewSection: "profile", profile, matches, missing }`; the Repo List's empty area
`{ webviewSection: "repoList" }`. The Command Palette hides the row-only commands.

## Architecture

- **`src/profileModel.ts` (pure, no `vscode`)** — `readProfiles(raw)` (lenient parse),
  `repoKey(root, folders)` (the relative entry), `resolve(profiles, repos, keyOf)` → per profile
  `{ ids, missing }`, `activeProfiles(resolved, repoIds)`, `showSave(resolved, repoIds)`, and
  the edits `saveProfile / renameProfile / deleteProfile / setMembership` returning a new
  object. All tested in `src/profileModel.test.ts` (appended to `test:unit`).
- **`LogView`** — reads the setting, resolves it against the discovered repositories, sends
  `{ type: "profiles", rows }` to the webview with the repositories; runs the commands; writes
  with `getConfiguration("polylog").update("profiles", next, ConfigurationTarget.Workspace)`.
  Switching a profile goes through the existing repo-filter path (`setFilter` with `repoIds`),
  so the Log, the Uncommitted store and Compare follow as they do for a tick.
- **`src/webview/repoPane.ts`** — renders profile rows and the ＋ row from the posted data;
  clicks post `{ type: "profile", name }` / `{ type: "profileSave" }`. No profile logic in the
  webview beyond drawing what it is sent.
- **`src/protocol.ts`** — the two messages and `ProfileRow { name, count, missing: string[], active }`.

Standing constraints: profiles only choose which repositories `git log` runs in (constraint 1:
no index, no filtering in JavaScript); rows use `--vscode-list-*` and theme icons (constraint 2);
fixtures and docs use `acme-*` and `backend`/`frontend` (constraint 3); setting writes are async
and never block the host (constraint 4).

## Error handling

- Writing the setting fails (read-only workspace file, no folder open): an error message
  "Polylog could not save the profile: …"; the Repo List is unchanged.
- No workspace folder (a single file open): save commands say profiles need a folder.
- Rename/save to an existing name: inline validation in the input box, never a silent overwrite
  (Save replaces only after the warning is shown).

## Testing

- Unit (`profileModel.test.ts`): lenient parse; relative keys in single- and multi-root; resolve
  with missing entries and duplicates; active detection (exact set, All, two equal profiles);
  ＋ row visibility; each edit.
- Integration (`log.itest.ts`): save the ticks as a profile (setting written, row shown and
  active); switch with a filter set (Author stays); tick one more (no active row); Profiles… on a
  repository adds and removes; rename; delete (asks); a missing entry is skipped and reported;
  a hand edit of the setting re-renders.
- Dev harness: mock profiles in `dev/harness/shim.ts`; check dark, light, high contrast.
- UI Map: add **Profile row** and **Save as profile row** to the Repo List entries.

## Docs

README (Repo List section): one paragraph on profiles and the setting. CHANGELOG at release.
