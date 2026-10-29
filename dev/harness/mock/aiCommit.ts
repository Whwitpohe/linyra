import type { CommitHostMessage, CommitWebviewMessage } from "../../../src/commitProtocol";

// The Commit side bar's ✨ in the harness: a fake model streams a message in small pieces, as the
// host would post it. ?ai=off hides the button (no AI in the build), ?ai=error answers with an
// error, ?ai=slow streams slowly (for screenshots of the busy state).
const REPLY = "feat(api): retry the upload once\n\nThe second try reuses the token, so a dropped connection no longer fails the release in acme-api and acme-web.";

export function mockAiCommit(send: (m: CommitHostMessage) => void, params: URLSearchParams): { ai: boolean; handle(m: CommitWebviewMessage): void } {
  const mode = params.get("ai") ?? "on";
  const step = mode === "slow" ? 400 : 25;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { clearTimeout(timer); timer = undefined; };
  return {
    ai: mode !== "off",
    handle(m) {
      if (m.type === "generateStop" && timer) { stop(); send({ type: "generated", text: "", done: true }); return; }
      if (m.type !== "generate") return;
      stop();
      send({ type: "generating" });
      if (mode === "error") {
        timer = setTimeout(() => { timer = undefined; send({ type: "generated", text: "", done: true, error: "Linyra AI: the API key was not accepted (401). Run Linyra: Configure AI…." }); }, step);
        return;
      }
      let at = 0;
      const next = () => {
        at = Math.min(REPLY.length, at + 12);
        if (at < REPLY.length) { send({ type: "generated", text: REPLY.slice(0, at), done: false }); timer = setTimeout(next, step); }
        else { timer = undefined; send({ type: "generated", text: REPLY, done: true }); }
      };
      timer = setTimeout(next, step);
    },
  };
}
