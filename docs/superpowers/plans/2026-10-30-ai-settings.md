# Linyra AI settings page — one editor tab instead of the QuickPick chains

The maintainer: "the Configure AI popups are ugly, they appear at the top of VS Code — can't we
build a user-friendly UI ourselves?" Today **Configure AI…** is a five-step QuickPick/InputBox
wizard (protocol → base URL → key → model → thinking level → test), **Switch AI Model…** a
QuickPick with item buttons, **Remove AI Profile…** a multi-select QuickPick and a modal. Each
step hides what came before, and a failed test is a modal with a raw sentence.

GitLens for comparison: its AI setup is still QuickPicks (Switch AI Provider/Model), its settings
page links out to them, and keys go through an InputBox. Linyra goes one step further: one page
that shows every profile and edits one at a time, in VS Code's own colors.

## Where

- One editor tab, **Linyra AI** (`linyra.aiSettings`, a `WebviewPanel`; one instance, revealed
  again when open; `retainContextWhenHidden` so a half-filled form survives a tab switch).
- `linyra.ai.configure`, `linyra.ai.switchModel`, `linyra.ai.removeProfile` keep their ids, titles
  and menu entries; each opens the page:
  - Configure AI… — the add form when there is no profile yet, else the list.
  - Switch AI Model… — the list, focus on the profile in use.
  - Remove AI Profile… — the list, focus on the first profile.
- `ensureReady()` (every AI feature asks it first): when AI is not set up it still asks first
  ("Configure AI…"), then opens the page and waits until a profile is in use and AI is on (the
  feature goes on, as after the old wizard) or the page closes (false).

## The page, top to bottom

**Header.** "Linyra AI" and one line: prompts go only to the profile in use; keys stay in VS Code's
secret storage. A checkbox (VS Code Elements, as the Repo List) **Use AI features** bound to
`linyra.ai.enabled`; disabled with "Add a profile first" while there is none. "More settings…"
opens the Settings editor at `linyra.ai` (exclude globs, prompt size, commit-message rules).

**Profiles.** A list, one row per profile:

```
(•) Anthropic · claude-opus-5-5                     In use        [Edit] [Remove]
    Anthropic · api.anthropic.com · Thinking: High · Key stored
( ) llama3 on localhost                              [Use]        [Edit] [Remove]
    OpenAI-compatible · localhost:11434 · Thinking: Default · No key
```

- **Use** makes it the profile in use and turns AI on (the old Switch).
- **Remove** turns the row into a confirmation that says what goes: "Remove 'X'? Its API key is
  deleted from VS Code's secret storage." plus, for the profile in use, what happens next ("Linyra
  AI will use 'Y'." / "Linyra AI will have no profile until you add one."). Remove / Cancel; Esc
  cancels. Nothing is deleted before the second click.
- Empty state: "No AI profile yet — add one to use ✨ in the Log." and **Add Profile**.
- **Add Profile** under the list.

**The form** (add or edit; one at a time, below the list, its heading says which):

| Field | Control | Rules |
|---|---|---|
| Provider | three radio cards: OpenAI-compatible, Anthropic, Google Gemini, each with one line of what it covers | changing it resets a base URL that was the old default, clears the model list |
| Address | Anthropic and Gemini: their default shown as text, "Use another address (gateway)…" opens the field; OpenAI-compatible: always a field, with presets OpenAI · Ollama · LM Studio | `checkBaseUrl` (error), `isPlainRemote` (warning: the key would cross the network in the clear) |
| API key | password field; for a stored key: "Stored for api.anthropic.com" with **Replace** and **Remove** — the key itself never reaches the webview | see *Keys* |
| Model | combobox: free text, ▾ lists the provider's models (id, name, context), filtered as you type; ⟳ reloads | required; the list's state is a line under it |
| Thinking level | segmented radios: Default and the levels the model takes (`effortChoices`) | hidden when the model takes none; "unknown" note when the provider does not say |
| Name | text field, placeholder = the generated name (`profileLabel`) | empty = generated, and it follows the model |
| Use this profile | checkbox (new: checked; editing the one in use: hidden) | |

Buttons: **Test Connection** (Stop while it runs), **Save** (primary), **Cancel**. Enter in a field
saves; Esc in the combobox closes its list first.

### Keys

The host tells the webview per profile only `{ stored: boolean, origin }` (origin = scheme, host,
port: where the key may be sent). The webview sends one of:

- `keep` — the stored key of the profile being edited (only offered when its origin is the form's).
- `from: <profile id>` — a new profile on an address another profile of the same provider already
  has a key for: "Uses the key stored for 'X'"; the host copies the secret on save.
- `new: <text>` — typed. Sent to the host for Load models, Test and Save; never posted back.
- `none` — no key (Remove, or nothing typed).

When the address moves to another origin, a stored key is not offered ("The stored key was entered
for https://a; it is never sent to b. Enter a key for this address."), as `AiKeys.keyFor` already
refuses. The host checks every message again (`checkDraft`): the webview is not trusted.

A typed key is bound to the origin it was typed for (after review): it is never sent while it is
typed, and an address on another origin clears it, saying why. A redirect to another origin drops
the key headers (`net.ts`), and a key a provider echoes in an error is cut out before the page sees
it.

### Models

Loaded when the form opens and 600 ms after the address changes, when the key is a stored one
(bound to its origin by the host) or none is needed (a local server); with a typed key, when the
list is opened (focus, ↓, ▾, Reload). One request at a time per page: a new one aborts the old
(`AbortController`), replies carry a sequence number, and a reply for an older form is dropped.
Line under the field: "Fetching the models of host…" / "24 models from host" / the failure in the
page's words (401: check the key; 404: check the address) / "Enter the API key to load the model
list, or type the model id."

### Test Connection

Two steps, each reported in plain words — what worked, then what failed and what to do next:

1. **Address and key**: `listModels` → "Reached api.anthropic.com; the key was accepted (24 models)."
   A 401/403 or a network failure stops here (step 2 would fail the same way); a 404 (some
   gateways have no /models) goes on.
2. **Model**: one tiny request ("Reply with the word OK.") with the chosen thinking level →
   "claude-opus-5-5 answered in 1.2 s."

Failures by kind (`AiError.kind`, plus the HTTP status and the provider's own words, which
`httpError` now keeps on the error): 401 key not accepted → check the key; 403 → the key cannot
use this model or address; 404 → check the address (OpenAI-compatible servers usually end in /v1)
and the model id; 400/422 → if a thinking level is chosen, try Default; 429 → the key works, wait
or check the quota; network → the existing sentence (DNS, refused, certificate, proxy); 5xx → try
later. A refusal still means it connected.

### Save

The host validates, writes the secret first (`AiKeys.set`, or copies the `from` secret, or deletes
it for `none`), then `linyra.ai.profiles` / `activeProfile` / `enabled` (User settings, as now). The
form closes and the page says "Saved. Linyra AI uses X." (an `aria-live` line). Settings changed
elsewhere (settings.json) re-render the list.

### Waiting for the setup

`ensureReady()` opens the page and waits until a profile is in use and AI is on; it gives up
(false) when the page closes, is left for another tab, or after ten minutes, so a feature's
request never goes out much later, unasked.

## Also in this branch (asked during the work)

- **Resolve Conflicts with AI**, one choice per file: it asked twice (a QuickPick, then a modal),
  and dismissing either ended the run. Now, beside the proposal's diff: Accept and Stage, Open in
  Merge Editor, Skip, or Stop while files are left. The list stays open while the diff is read; Esc
  skips the file and the run goes on. The end says how many were staged and that the operation is
  the user's to continue (Open Source Control). Pure parts: `reviewStep`, `resolveReport`.
- **`stashWriter()`** on the AI features, for a Stash Changes… box of its own (`src/stashBox.ts`).

## Code

- `src/ai/settingsModel.ts` (pure, tests in `settingsModel.test.ts`): the draft and its validation,
  key availability, provider switch, thinking choices, model filter, the test report, the removal
  sentence, the row summary, and `checkDraft` for the host.
- `src/ai/settingsProtocol.ts`: the messages.
- `src/ai/settingsPanel.ts`: the panel (vscode only): state, keys, models, test, save, use, remove.
  Reached only through `LinyraAi` in `service.ts` (a later lazy `out/ai.js` cuts there); no
  module-level state.
- `src/ai/configure.ts`: removed (its flows move to the page).
- `src/webview/aiSettings/{html,main,view}.ts`, `aiSettings.css`: the webview, its own bundle
  `out/aiSettings.js`/`.css` (`bundle:aiSettings`).
- `dev/harness`: `aiSettings.html` (+ `.zh-cn`), `aiSettingsShim.ts` with mock profiles, models and
  test outcomes (`?state=empty|profiles|edit`, `?models=fail`, `?test=ok|auth|404|network`).
- Strings: `l10n/bundle.l10n.zh-cn.json`; settings descriptions in `package.nls*.json` now name the
  page.

## Tests

1. Unit (`settingsModel.test.ts`): validation messages and severities, key states (stored, other
   origin, shared, local), provider switch, effort choices and resets, model filter, test reports
   for every failure kind, removal sentences, `checkDraft` rejecting bad input.
2. Harness (`aiSettings.spec.mjs`), dark, light, hc-dark, hc-light and 360 px wide: empty state,
   list and Use, Remove confirmation, add form with inline validation, key states, combobox by
   keyboard, thinking levels following the model, Test results, Save posts no stored key, no
   horizontal scroll at 360 px, focus visible.
3. Integration (`aiSettings.itest.ts`, VS Code 1.144.0 and 1.85.0): each command opens the page;
   saving a profile writes the settings and the secret (checked through a test seam that compares,
   never returns, the key); Use, Remove; Test Connection against a local OpenAI-compatible server on
   127.0.0.1 (fake models and an OK answer, a 401 for a wrong key).
