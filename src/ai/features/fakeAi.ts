// A fake AiService for the features' unit tests: scripted replies, every request kept. Pure.
import { AiError, type AiRequest, type AiResponse, type AiService } from "../types";

export interface FakeAi extends AiService {
  requests: AiRequest[];
  presented: { title: string; text: string }[];
}

/** Replies in order (text, or a whole response); onText gets each reply in two halves, as a stream would. */
export function fakeAi(replies: (string | Partial<AiResponse>)[], opts: { configured?: boolean; ready?: boolean; excluded?: (path: string) => boolean } = {}): FakeAi {
  const queue = [...replies];
  const fake: FakeAi = {
    requests: [],
    presented: [],
    configured: opts.configured ?? true,
    profile: undefined,
    ensureReady: async () => opts.ready ?? true,
    ask: async (request) => {
      fake.requests.push(request);
      const next = queue.shift();
      if (next === undefined) throw new AiError("no scripted reply", "server");
      const res: AiResponse = typeof next === "string" ? { text: next, toolCalls: [], stop: "end" } : { text: "", toolCalls: [], stop: "end", ...next };
      if (request.onText && res.text) {
        const half = Math.ceil(res.text.length / 2);
        request.onText(res.text.slice(0, half));
        request.onText(res.text.slice(half));
      }
      return res;
    },
    present: async (title, run) => {
      const entry = { title, text: "" };
      fake.presented.push(entry);
      await run((markdown) => { entry.text += markdown; }, new AbortController().signal);
    },
    excluded: opts.excluded ?? ((path) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.min\.|(^|\/)(dist|out|build|node_modules)\/|(^|\/)\.env|\.(pem|key)$/.test(path)),
  };
  return fake;
}
