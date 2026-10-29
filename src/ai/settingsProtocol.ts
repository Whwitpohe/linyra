// Messages between the Linyra AI page (an editor-tab webview) and the host. Pure types. No key ever
// travels to the webview: a profile says only whether one is stored, and for which origin.
import type { AiEffort, AiError, AiModel, AiProtocol } from "./types";

/** A saved profile as the page shows it. */
export interface ProfileRow {
  id: string;
  label: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  effort: AiEffort;
  /** A key is stored in SecretStorage, entered for `origin` (scheme, host and port): it is only ever sent there. */
  key: { stored: boolean; origin?: string };
}

export interface AiSettingsState {
  type: "state";
  /** linyra.ai.enabled. */
  enabled: boolean;
  /** The profile in use: the active id, or the only profile. */
  activeId: string | undefined;
  profiles: ProfileRow[];
}

/** The form as typed: unchecked until the host's checkDraft. */
export interface DraftProfile {
  /** The profile being edited; undefined for a new one. */
  id?: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  effort: AiEffort;
  /** Empty: the generated name, which follows the model. */
  label: string;
}

/**
 * Which key a request or a save uses. `keep`: the edited profile's stored key; `from`: another
 * profile's stored key for the same provider and origin (copied on save); `new`: typed; `none`.
 */
export type KeyChoice = { kind: "keep" } | { kind: "from"; profileId: string } | { kind: "new"; value: string } | { kind: "none" };

/** One step of Test Connection, as it went. */
export type StepResult =
  | { ok: true; ms: number; count?: number; answeredBy?: string; refused?: boolean }
  | { ok: false; kind: AiError["kind"]; message: string; status?: number; detail?: string; html?: boolean };

/** Test Connection: listing the models (address and key), then one tiny request (model and thinking level). */
export interface TestOutcome {
  /** A key was sent. */
  keyed: boolean;
  list: StepResult;
  /** Not tried when the first step already showed it would fail the same way (key, network). */
  send?: StepResult;
}

/** What opened the page: the add form, or the list (with the focus on a profile). */
export type AiSettingsView = { view: "add" } | { view: "list"; focus?: "active" | "first" };

export type AiSettingsHostMessage =
  | AiSettingsState
  | ({ type: "open" } & AiSettingsView)
  | { type: "models"; seq: number; models?: AiModel[]; error?: string }
  | { type: "testStep"; seq: number; step: 1 | 2 }
  | { type: "tested"; seq: number; outcome: TestOutcome }
  /** A save, a Use or a Remove went through (`note` says so on the page) or failed (`error`). */
  | { type: "done"; action: "save" | "use" | "remove" | "enable"; note?: string; error?: string; id?: string };

export type AiSettingsWebviewMessage =
  | { type: "ready" }
  | { type: "models"; seq: number; draft: DraftProfile; key: KeyChoice }
  | { type: "test"; seq: number; draft: DraftProfile; key: KeyChoice }
  | { type: "stopTest" }
  | { type: "save"; draft: DraftProfile; key: KeyChoice; use: boolean }
  | { type: "use"; id: string }
  | { type: "remove"; id: string }
  | { type: "enable"; on: boolean }
  /** The Settings editor at linyra.ai: exclude globs, prompt size, commit-message rules. */
  | { type: "moreSettings" };
