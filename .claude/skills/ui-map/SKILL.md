---
name: ui-map
description: Open the Linyra UI Map, the page that names every part of the Linyra panel (Repo List, Log toolbar, Commit row, Changes view…), so the maintainer and Claude use the same words. Use when the maintainer asks to "show the UI map", "open the map", "what is this part called", or refers to a part by a map name; and after any change that adds, removes or renames a visible part, to bring the map up to date.
---

# Linyra UI Map

`dev/ui-map/index.html` draws the Linyra panel (VS Code's look, both themes) with a red box and
a number on every named part, and a glossary below: number, name, what it is. Clicking a box,
its number or its glossary entry copies the name. Dev-only: `.vscodeignore` is an allowlist, so
nothing in `dev/` ships.

## Open it

```bash
npm run ui-map            # http://localhost:5179/ (PORT=… to change)
```

Run it in the background, then give the maintainer the URL. The page is read on every request,
so edits show on a reload.

## Use the names

When the maintainer names a part ("the Sync badge", "Repo List row"), look it up in the
glossary of `dev/ui-map/index.html` before acting: the name maps to one region and one piece of
code. Use the same names in replies, specs and commit messages.

## Keep it current

After a change that adds, removes, renames or moves a visible part (a view, a toolbar button, a
menu, a box in the Filter bar):

1. Update the mock: add or move the element; give a named region `class="… t"` and a tag
   `<i class="n tl">N</i>` as its first child.
2. Add or edit its glossary entry: `<div class="g"><i class="num">N</i><b>Name</b><span>…</span></div>`.
   Numbers follow the page order; renumbering is fine, the names are what stays stable.
3. Planned parts use the amber style (`planned-box`, `g planned`) until they ship.
4. Neutral names only (acme-web, acme-api, dana, rin): `npm run check:denylist` scans `dev/` too.
5. Check it once in a browser: every box has its number, clicking copies the right name, and the
   page has no horizontal scroll (only the mocks scroll sideways).
