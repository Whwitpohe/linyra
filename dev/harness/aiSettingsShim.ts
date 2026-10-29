import { profileLabel } from "../../src/ai/profileModel";
import type { AiSettingsHostMessage, AiSettingsWebviewMessage, ProfileRow, StepResult, TestOutcome } from "../../src/ai/settingsProtocol";
import type { AiModel } from "../../src/ai/types";

// The Linyra AI page with a mock host. Parameters:
//   theme   dark | light | hc-dark | hc-light
//   state   profiles (default) | empty | off (AI turned off)
//   open    list (default) | add | first: what the command opened it on
//   models  ok (default) | fail | empty | slow (never answers)
//   test    ok (default) | auth | notfound | network | level | nolist | slow
//   save    ok (default) | fail
const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
document.getElementById("theme")!.setAttribute("href", `themes/${theme}.css`);
document.body.classList.add(theme === "hc-dark" ? "vscode-high-contrast" : theme === "hc-light" ? "vscode-high-contrast-light" : `vscode-${theme}`);
const mode = (name: string, fallback: string) => params.get(name) ?? fallback;

const anthropic = "https://api.anthropic.com";
let profiles: ProfileRow[] = mode("state", "profiles") === "empty" ? [] : [
  { id: "ai-1", label: "Anthropic · claude-opus-5-5", protocol: "anthropic", baseUrl: anthropic, model: "claude-opus-5-5", effort: "high", key: { stored: true, origin: anthropic } },
  { id: "ai-2", label: "Local llama", protocol: "openai", baseUrl: "http://localhost:11434/v1", model: "llama3.1:8b", effort: "default", key: { stored: false } },
  { id: "ai-3", label: "Gemini · gemini-3-pro", protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-3-pro", effort: "low",
    key: { stored: true, origin: "https://generativelanguage.googleapis.com" } },
];
let activeId: string | undefined = profiles[0]?.id;
let enabled = mode("state", "profiles") !== "off" && profiles.length > 0;
let next = 10;

const MODELS: Record<string, AiModel[]> = {
  anthropic: [
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", contextTokens: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextTokens: 1_000_000, efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-haiku-5", label: "Claude Haiku 5", contextTokens: 200_000, efforts: ["low", "medium", "high"] },
    { id: "claude-opus-4-5", label: "Claude Opus 4.5", contextTokens: 200_000, efforts: ["low", "medium", "high"] },
  ],
  openai: [
    { id: "llama3.1:8b" }, { id: "qwen2.5-coder:7b" }, { id: "mistral:7b" }, { id: "gpt-oss:20b" },
  ],
  gemini: [
    { id: "gemini-3-pro", label: "Gemini 3 Pro", contextTokens: 1_048_576 },
    { id: "gemini-3-flash", label: "Gemini 3 Flash", contextTokens: 1_048_576 },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", contextTokens: 1_048_576 },
  ],
};

const host = window as unknown as { acquireVsCodeApi(): unknown; aiMessages: AiSettingsWebviewMessage[]; aiPosted: AiSettingsHostMessage[] };
host.aiMessages = [];
host.aiPosted = [];
const send = (data: AiSettingsHostMessage) => {
  host.aiPosted.push(data);
  window.dispatchEvent(new MessageEvent("message", { data }));
};
const state = () => send({ type: "state", enabled, activeId, profiles: profiles.map((p) => ({ ...p, key: { ...p.key } })) });
const later = (ms: number, run: () => void) => setTimeout(run, ms);
const fail = (status: number, message: string, detail?: string): StepResult => ({ ok: false, kind: status === 401 ? "auth" : status === 429 ? "rateLimit" : "badRequest", message, status, detail });
let testTimers: ReturnType<typeof setTimeout>[] = [];

host.acquireVsCodeApi = () => ({
  postMessage(m: AiSettingsWebviewMessage) {
    host.aiMessages.push(m);
    switch (m.type) {
      case "ready": {
        state();
        const open = mode("open", "list");
        later(0, () => send(open === "add" ? { type: "open", view: "add" } : { type: "open", view: "list", focus: open === "first" ? "first" : "active" }));
        return;
      }
      case "models": {
        const how = mode("models", "ok");
        if (how === "slow") return;
        later(120, () => send(how === "fail" ? { type: "models", seq: m.seq, error: "Could not connect to localhost:11434: nothing is listening there. Is the server running?" }
          : { type: "models", seq: m.seq, models: how === "empty" ? [] : MODELS[m.draft.protocol] }));
        return;
      }
      case "test": {
        const how = mode("test", "ok");
        const count = MODELS[m.draft.protocol].length;
        const outcome: TestOutcome =
          how === "auth" ? { keyed: true, list: fail(401, "The API key was not accepted (401).", "invalid x-api-key") }
          : how === "network" ? { keyed: true, list: { ok: false, kind: "network", message: "Could not find gateway.example.com. Check the base URL, your network and the proxy settings (http.proxy)." } }
          : how === "notfound" ? { keyed: true, list: { ok: true, ms: 90, count }, send: fail(404, "Not found (404): check the base URL and the model id.", "model: no-such-model") }
          : how === "level" ? { keyed: true, list: { ok: true, ms: 90, count }, send: fail(400, "The provider rejected the request (400).", "effort is not supported for this model") }
          : how === "nolist" ? { keyed: true, list: fail(404, "Not found (404): check the base URL and the model id."), send: { ok: true, ms: 640 } }
          : { keyed: m.key.kind !== "none", list: { ok: true, ms: 110, count }, send: { ok: true, ms: 1240 } };
        if (how === "slow") {
          testTimers.push(later(50, () => send({ type: "testStep", seq: m.seq, step: 1 })));
          return;
        }
        testTimers.push(later(60, () => send({ type: "testStep", seq: m.seq, step: 1 })));
        if (outcome.send) testTimers.push(later(140, () => send({ type: "testStep", seq: m.seq, step: 2 })));
        testTimers.push(later(260, () => send({ type: "tested", seq: m.seq, outcome })));
        return;
      }
      case "stopTest":
        testTimers.forEach(clearTimeout);
        testTimers = [];
        return;
      case "save": {
        if (mode("save", "ok") === "fail") {
          later(100, () => send({ type: "done", action: "save", error: "Unable to write to User Settings because the file has unsaved changes." }));
          return;
        }
        const id = m.draft.id ?? `ai-${next++}`;
        const label = m.draft.label || profileLabel(m.draft.protocol, m.draft.baseUrl, m.draft.model);
        const origin = new URL(m.draft.baseUrl).origin;
        const before = profiles.find((p) => p.id === id);
        const key = m.key.kind === "none" ? { stored: false } : m.key.kind === "keep" ? before?.key ?? { stored: false } : { stored: true, origin };
        const saved: ProfileRow = { id, label, protocol: m.draft.protocol, baseUrl: m.draft.baseUrl, model: m.draft.model, effort: m.draft.effort, key };
        profiles = before ? profiles.map((p) => (p.id === id ? saved : p)) : [...profiles, saved];
        if (m.use) {
          activeId = id;
          enabled = true;
        } else activeId ??= profiles.length === 1 ? id : activeId;
        later(100, () => {
          state();
          send({ type: "done", action: "save", id, note: m.use ? `Saved. Linyra AI now uses ${label}.` : `Saved “${label}”.` });
        });
        return;
      }
      case "use": {
        const p = profiles.find((x) => x.id === m.id);
        if (!p) return;
        activeId = p.id;
        enabled = true;
        later(60, () => {
          state();
          send({ type: "done", action: "use", id: p.id, note: `Linyra AI now uses ${p.label}.` });
        });
        return;
      }
      case "remove": {
        const p = profiles.find((x) => x.id === m.id);
        if (!p) return;
        profiles = profiles.filter((x) => x.id !== m.id);
        if (activeId === m.id) activeId = profiles[0]?.id;
        later(60, () => {
          state();
          send({ type: "done", action: "remove", id: p.id, note: `Removed “${p.label}”.` });
        });
        return;
      }
      case "enable":
        enabled = m.on;
        later(30, () => {
          state();
          send({ type: "done", action: "enable", note: m.on ? "Linyra AI is on." : "Linyra AI is off: nothing is sent to any AI provider." });
        });
        return;
      case "moreSettings":
        return;
    }
  },
});
