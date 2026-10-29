import * as assert from "assert";
import { createHash } from "crypto";
import { Avatars, visibleAuthors, type AvatarFetch, type AvatarResponse } from "./avatars";
import { DEFAULT_AVATAR_SETTINGS, type AvatarSettings } from "./settings";

// No test reaches the network: every request goes to a fake fetch.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_URI = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
const json = (value: unknown): AvatarResponse => ({ status: 200, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify(value)) });
const png: AvatarResponse = { status: 200, contentType: "image/png", body: PNG };
const status = (s: number, location?: string): AvatarResponse => ({ status: s, location, body: new Uint8Array() });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const REMOTES: Record<string, string[]> = {
  "/work/acme-api": ["git@gitlab.acme.test:acme/acme-api.git"],
  "/work/acme-web": ["https://github.com/acme/acme-web.git"],
  "/work/acme-libs": ["/srv/git/acme-libs.git"],
};

function setup(answer: (url: string, signal: AbortSignal) => AvatarResponse | Promise<AvatarResponse>, patch: Partial<AvatarSettings> = {}) {
  const asked: string[] = [];
  const posts: { byEmail: Record<string, string>; reset: boolean }[] = [];
  const logs: string[] = [];
  const remoteReads: string[] = [];
  let settings: AvatarSettings = { ...DEFAULT_AVATAR_SETTINGS, ...patch };
  let inFlight = 0, maxInFlight = 0;
  const fetch: AvatarFetch = async (url, { signal }) => {
    asked.push(url);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await answer(url, signal);
    } finally {
      inFlight--;
    }
  };
  const avatars = new Avatars({
    settings: () => settings,
    remotes: async (repoId) => { remoteReads.push(repoId); return REMOTES[repoId] ?? []; },
    post: (byEmail, reset) => posts.push({ byEmail, reset }),
    log: (m) => logs.push(m),
    fetch, timeoutMs: 30, batchMs: 5,
  });
  return { avatars, asked, posts, logs, remoteReads, maxInFlight: () => maxInFlight, set: (p: Partial<AvatarSettings>) => { settings = { ...settings, ...p }; } };
}

const tick = () => new Promise((r) => setTimeout(r, 1));
async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await tick();
  }
}
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const gitlabApi = (email: string) => `https://gitlab.acme.test/api/v4/avatar?email=${encodeURIComponent(email)}&size=64`;
const UPLOAD = "https://gitlab.acme.test/uploads/-/system/user/avatar/7/avatar.png?width=64";

void (async () => {
  {
    const t = setup((url) => (url.includes("/api/v4/avatar") ? json({ avatar_url: UPLOAD }) : png));
    t.avatars.want([{ email: "Dana@Example.com", repoId: "/work/acme-api" }]);
    await until(() => t.posts.length > 0);
    assert.deepStrictEqual(t.asked, [gitlabApi("dana@example.com"), UPLOAD], "the instance's API, then its picture");
    assert.deepStrictEqual(t.posts, [{ byEmail: { "dana@example.com": PNG_URI }, reset: false }]);
    // On screen again, or scrolled back: no request.
    t.avatars.want([{ email: "dana@example.com", repoId: "/work/acme-api" }]);
    await settle();
    assert.strictEqual(t.asked.length, 2);
    assert.strictEqual(t.posts.length, 1, "the webview has it already");
    // A re-created webview has nothing: it gets it from memory, still with no request.
    t.avatars.webviewReset();
    t.avatars.want([{ email: "dana@example.com", repoId: "/work/acme-api" }]);
    await settle();
    assert.strictEqual(t.asked.length, 2);
    assert.deepStrictEqual(t.posts[1], { byEmail: { "dana@example.com": PNG_URI }, reset: false });
    assert.deepStrictEqual(t.remoteReads, ["/work/acme-api"], "each repository's remotes are read once");
    console.log("ok - a GitLab author: its API, then its picture, once per session; a new webview gets it from memory");
  }
  {
    const t = setup((url) => (url.includes("/u/") ? png : status(404)));
    t.avatars.want([
      { email: "12345+dana@users.noreply.github.com", repoId: "/work/acme-web" },
      { email: "rin@example.com", repoId: "/work/acme-web" },
      { email: "rin@example.com", repoId: "/work/acme-libs" },
    ]);
    await until(() => t.posts.length > 0);
    await settle();
    assert.deepStrictEqual(t.asked, ["https://avatars.githubusercontent.com/u/12345?s=64"], "GitHub for its noreply address; nothing for the others, and nothing of a local remote");
    assert.deepStrictEqual(Object.keys(t.posts[0].byEmail), ["12345+dana@users.noreply.github.com"]);
    console.log("ok - by default only the repository's own hosts are asked");
  }
  {
    const t = setup((url) => (url.includes("/api/v4/avatar") ? json({ avatar_url: `https://secure.gravatar.com/avatar/${sha256("x")}?s=64&d=identicon` }) : png));
    t.avatars.want([{ email: "rin@example.com", repoId: "/work/acme-api" }]);
    await settle();
    assert.deepStrictEqual(t.asked, [gitlabApi("rin@example.com")], "GitLab's Gravatar URL is not followed");
    assert.strictEqual(t.posts.length, 0);
    const g = setup((url) => (url.includes("/api/v4/avatar") ? json({ avatar_url: "https://gitlab.acme.test/assets/no_avatar-abc.png" }) : url.includes("gravatar") ? png : status(404)), { mode: "remote+gravatar" });
    g.avatars.want([{ email: "rin@example.com", repoId: "/work/acme-api" }]);
    await until(() => g.posts.length > 0);
    assert.deepStrictEqual(g.asked, [gitlabApi("rin@example.com"), `https://www.gravatar.com/avatar/${sha256("rin@example.com")}?s=64&d=404`],
      "no picture on the instance: Gravatar, when chosen, with d=404");
    console.log("ok - GitLab's placeholders and Gravatar URLs are dropped; Gravatar is asked only when chosen");
  }
  {
    const t = setup(() => status(403));
    t.avatars.want([{ email: "dana@example.com", repoId: "/work/acme-api" }]);
    await settle();
    t.avatars.want([{ email: "rin@example.com", repoId: "/work/acme-api" }, { email: "dana@example.com", repoId: "/work/acme-api" }]);
    await settle();
    assert.deepStrictEqual(t.asked, [gitlabApi("dana@example.com")], "a 403 breaks the host for the session");
    assert.strictEqual(t.logs.length, 1);
    assert.ok(t.logs[0].includes("gitlab.acme.test") && t.logs[0].includes("403"), t.logs[0]);
    const s = setup(() => status(302, "https://gitlab.acme.test/users/sign_in"));
    s.avatars.want([{ email: "dana@example.com", repoId: "/work/acme-api" }, { email: "rin@example.com", repoId: "/work/acme-api" }]);
    await settle();
    assert.ok(s.asked.length <= 2 && s.asked.every((u) => u.includes("/api/v4/avatar")), "the sign-in page is never fetched");
    s.avatars.want([{ email: "noor@example.com", repoId: "/work/acme-api" }]);
    await settle();
    assert.ok(!s.asked.some((u) => u.includes("noor")), "a sign-in redirect breaks the host too");
    assert.ok(s.logs[0].includes("sign-in"), s.logs[0]);
    const n = setup(() => status(404));
    n.avatars.want([{ email: "dana@example.com", repoId: "/work/acme-api" }]);
    await settle();
    n.avatars.want([{ email: "rin@example.com", repoId: "/work/acme-api" }]);
    await settle();
    assert.deepStrictEqual(n.asked, [gitlabApi("dana@example.com")], "a 404 from GitLab's API: it is no GitLab, asked no more");
    const h = setup((url) => (url.includes("/api/v4/avatar") ? json({ avatar_url: UPLOAD }) : { status: 200, contentType: "text/html", body: new TextEncoder().encode("<html>Sign in</html>") }));
    h.avatars.want([{ email: "dana@example.com", repoId: "/work/acme-api" }]);
    await settle();
    h.avatars.want([{ email: "rin@example.com", repoId: "/work/acme-api" }]);
    await settle();
    assert.strictEqual(h.asked.length, 2, "a page served where a picture should be breaks the host");
    assert.strictEqual(h.posts.length, 0);
    // The instance sends its picture from its storage; the storage refusing breaks the storage, not the instance.
    const o = setup((url) => url.includes("/api/v4/avatar") ? json({ avatar_url: UPLOAD })
      : url.startsWith("https://gitlab.acme.test/uploads/") ? status(302, "https://storage.acme.test/avatars/7.png?sig=1") : status(403));
    o.avatars.want([{ email: "dana@example.com", repoId: "/work/acme-api" }]);
    await settle();
    o.avatars.want([{ email: "rin@example.com", repoId: "/work/acme-api" }]);
    await settle();
    assert.deepStrictEqual(o.asked, [gitlabApi("dana@example.com"), UPLOAD, "https://storage.acme.test/avatars/7.png?sig=1", gitlabApi("rin@example.com"), UPLOAD]);
    assert.ok(o.logs[0].includes("storage.acme.test"), o.logs[0]);
    console.log("ok - 401/403, a sign-in redirect or page, and a missing GitLab API stop Linyra asking that host this session");
  }
  {
    // Every request hangs until the 30 ms timeout aborts it.
    const t = setup((_url, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const authors = ["a", "b", "c", "d", "e", "f"].map((n) => ({ email: `${n}@example.com`, repoId: "/work/acme-api" }));
    t.avatars.want(authors);
    await until(() => t.logs.length > 0);
    await settle();
    assert.ok(t.maxInFlight() <= 4, `at most four requests at a time (${t.maxInFlight()})`);
    const asked = t.asked.length;
    assert.ok(asked >= 3 && asked <= 6, `three timeouts open the breaker (${asked} asked)`);
    assert.ok(t.logs[0].includes("5"), t.logs[0]);
    t.avatars.want(authors);
    await settle();
    assert.strictEqual(t.asked.length, asked, "cooling down: not asked");
    console.log("ok - four requests at a time, three seconds each; repeated timeouts open the host's breaker");
  }
  {
    const pending: (() => void)[] = [];
    const t = setup((url) => new Promise((resolve) => pending.push(() => resolve(url.includes("/api/v4/avatar") ? json({ avatar_url: UPLOAD }) : png))));
    const authors = Array.from({ length: 10 }, (_, i) => ({ email: `dev${i}@example.com`, repoId: "/work/acme-api" }));
    t.avatars.want(authors);
    await until(() => t.asked.length === 4);
    await settle();
    assert.strictEqual(t.asked.length, 4, "four at a time");
    // Scrolled: only the first two are still on screen. The queued eight are not asked.
    t.avatars.want(authors.slice(0, 2));
    while (pending.length) { pending.shift()!(); await settle(); }
    assert.ok(t.asked.every((u) => !/dev[4-9]/.test(u)), `rows scrolled away before their turn are not asked: ${t.asked.join(" ")}`);
    const sent = Object.assign({}, ...t.posts.map((p) => p.byEmail)) as Record<string, string>;
    assert.deepStrictEqual(Object.keys(sent).sort(), ["dev0@example.com", "dev1@example.com"], "only what is on screen is sent");
    assert.ok(t.posts.length <= 2, `answers arrive in batches (${t.posts.length})`);
    console.log("ok - only authors on screen are asked; a scroll drops the queue; results go in batches");
  }
  {
    const t = setup(() => png, { mode: "off" });
    t.avatars.want([{ email: "12345+dana@users.noreply.github.com", repoId: "/work/acme-web" }]);
    await settle();
    assert.deepStrictEqual(t.asked, [], "off: no request");
    t.set({ mode: "remote" });
    t.avatars.settingsChanged();
    await until(() => t.posts.length > 1);
    assert.deepStrictEqual(t.posts[0], { byEmail: {}, reset: true }, "a settings change resets the webview's avatars");
    assert.deepStrictEqual(t.posts[1].byEmail, { "12345+dana@users.noreply.github.com": PNG_URI }, "and asks again for the rows on screen");
    t.set({ mode: "off" });
    t.avatars.settingsChanged();
    await settle();
    assert.deepStrictEqual(t.posts.at(-1), { byEmail: {}, reset: true });
    assert.strictEqual(t.asked.length, 1);
    console.log("ok - off asks nothing; changing the settings forgets every answer");
  }
  {
    const known = new Set(["/work/acme-api"]);
    assert.deepStrictEqual(visibleAuthors([
      { email: "dana@example.com", repoId: "/work/acme-api" },
      { email: "rin@example.com", repoId: "/work/elsewhere" },
      { email: "not an address", repoId: "/work/acme-api" },
      { email: 7, repoId: "/work/acme-api" }, null, "x",
    ], (id) => known.has(id)), [{ email: "dana@example.com", repoId: "/work/acme-api" }]);
    assert.deepStrictEqual(visibleAuthors("dana", () => true), []);
    assert.strictEqual(visibleAuthors(Array.from({ length: 1000 }, () => ({ email: "dana@example.com", repoId: "/work/acme-api" })), () => true).length, 300);
    console.log("ok - the webview's report is validated: addresses of listed repositories, 300 at most");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
