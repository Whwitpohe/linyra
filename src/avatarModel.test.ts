import * as assert from "assert";
import { createHash } from "crypto";
import {
  admit, avatarSources, BREAKER, Breakers, classify, CLOSED, dataUri, expandTemplate, githubNoreply, gitlabAvatar, gravatarUrl,
  hostKind, imageType, isSignIn, normalizeEmail, parseRemoteConfig, record, redirectAllowed, remoteHosts, type Breaker,
} from "./avatarModel";
import { DEFAULT_AVATAR_SETTINGS, type AvatarSettings } from "./settings";

const settings = (patch: Partial<AvatarSettings> = {}): AvatarSettings => ({ ...DEFAULT_AVATAR_SETTINGS, ...patch });
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

{
  assert.deepStrictEqual(remoteHosts([
    "git@gitlab.acme.test:acme/acme-api.git",
    "https://dana:token@gitlab.acme.test/acme/acme-api.git",
    "ssh://git@ssh.github.com:443/acme/acme-web.git",
    "http://git.acme.test:8080/acme/acme-libs.git",
    "ssh://git@gitlab.acme.test:2222/acme/acme-libs.git",
    "/srv/git/acme-web.git",
    "C:\\repos\\acme-web.git",
  ]), [
    { scheme: "https", host: "gitlab.acme.test" },
    { scheme: "https", host: "github.com" },
    { scheme: "http", host: "git.acme.test", port: "8080" },
  ]);
  console.log("ok - remote hosts: scp and ssh remotes are their https web server, tokens dropped, ssh ports dropped, local paths none");
}
{
  assert.deepStrictEqual(parseRemoteConfig("remote.upstream.url https://github.com/acme/acme-web.git\nremote.origin.url git@gitlab.acme.test:acme/acme-web.git\nremote.a.b.url /srv/x\n"),
    ["git@gitlab.acme.test:acme/acme-web.git", "https://github.com/acme/acme-web.git", "/srv/x"]);
  assert.deepStrictEqual(parseRemoteConfig(""), []);
  console.log("ok - git config's remote URLs, origin first");
}
{
  const none = {};
  assert.strictEqual(hostKind({ scheme: "https", host: "github.com" }, none), "github");
  assert.strictEqual(hostKind({ scheme: "https", host: "gitlab.com" }, none), "gitlab");
  assert.strictEqual(hostKind({ scheme: "https", host: "gitlab.acme.test" }, none), "gitlab");
  assert.strictEqual(hostKind({ scheme: "https", host: "github.acme.test" }, none), "github");
  assert.strictEqual(hostKind({ scheme: "https", host: "git.acme.test" }, none), undefined, "an unknown server is asked nothing");
  assert.strictEqual(hostKind({ scheme: "https", host: "bitbucket.org" }, none), undefined);
  assert.strictEqual(hostKind({ scheme: "https", host: "gitlab" }, none), undefined, "a bare name is no proof");
  assert.strictEqual(hostKind({ scheme: "https", host: "git.acme.test" }, { "git.acme.test": "gitlab" }), "gitlab", "linyra.avatarHosts names it");
  assert.strictEqual(hostKind({ scheme: "http", host: "git.acme.test", port: "8080" }, { "git.acme.test:8080": "github", "git.acme.test": "gitlab" }), "github", "host:port first");
  assert.strictEqual(hostKind({ scheme: "https", host: "gitlab.acme.test" }, { "gitlab.acme.test": "github" }), "github", "the setting wins over the name");
  assert.strictEqual(hostKind({ scheme: "https", host: "constructor" }, {}), undefined);
  console.log("ok - host kind: linyra.avatarHosts first, then github.com, gitlab.com, gitlab.* and github.*");
}
{
  assert.deepStrictEqual(githubNoreply("12345+dana@users.noreply.github.com"), { id: "12345", login: "dana", host: "github.com" });
  assert.deepStrictEqual(githubNoreply("Dana@Users.Noreply.GitHub.com"), { login: "Dana", host: "github.com" });
  assert.deepStrictEqual(githubNoreply("49699333+acme-bot[bot]@users.noreply.github.com"), { id: "49699333", login: "acme-bot[bot]", host: "github.com" });
  assert.deepStrictEqual(githubNoreply("7+rin@users.noreply.github.acme.test"), { id: "7", login: "rin", host: "github.acme.test" });
  for (const e of ["dana@example.com", "dana@noreply.github.com", "-dana@users.noreply.github.com", "a/b@users.noreply.github.com", "dana@users.noreply."]) {
    assert.strictEqual(githubNoreply(e), undefined, e);
  }
  assert.strictEqual(normalizeEmail("  Dana@Example.COM "), "dana@example.com");
  for (const e of ["", "dana", "dana@", "@example.com", "da na@example.com", "<dana@example.com>", `${"a".repeat(250)}@example.com`]) assert.strictEqual(normalizeEmail(e), "", e);
  console.log("ok - GitHub noreply addresses, with or without the account id; addresses normalized");
}
{
  const gitlab = [{ scheme: "https" as const, host: "gitlab.acme.test" }];
  const github = [{ scheme: "https" as const, host: "github.com" }];
  const ghe = [{ scheme: "https" as const, host: "github.acme.test" }];
  const other = [{ scheme: "https" as const, host: "git.acme.test" }];
  const urls = (email: string, remotes: typeof gitlab, s = settings()) => avatarSources(email, remotes, s).map((x) => x.url);

  assert.deepStrictEqual(urls("Dana@Example.com", gitlab), ["https://gitlab.acme.test/api/v4/avatar?email=dana%40example.com&size=64"]);
  assert.strictEqual(avatarSources("dana@example.com", gitlab, settings())[0].kind, "gitlab");
  assert.deepStrictEqual(urls("12345+dana@users.noreply.github.com", github), ["https://avatars.githubusercontent.com/u/12345?s=64"]);
  assert.deepStrictEqual(urls("dana@users.noreply.github.com", github), ["https://avatars.githubusercontent.com/dana?s=64"], "login-only noreply: by login");
  assert.deepStrictEqual(urls("dana@example.com", github), [], "GitHub maps no other address to a picture without a token");
  assert.deepStrictEqual(urls("7+rin@users.noreply.github.acme.test", ghe), ["https://github.acme.test/rin.png?size=64"]);
  assert.deepStrictEqual(urls("12345+dana@users.noreply.github.com", gitlab), ["https://gitlab.acme.test/api/v4/avatar?email=12345%2Bdana%40users.noreply.github.com&size=64"],
    "a GitHub address in a GitLab repository: GitHub is not one of its hosts, so it is not asked");
  assert.deepStrictEqual(urls("dana@example.com", other), [], "an unknown server: nothing is asked");
  assert.deepStrictEqual(urls("dana@example.com", []), [], "no remote: nothing is asked");
  assert.deepStrictEqual(urls("dana@example.com", gitlab, settings({ mode: "off" })), []);
  assert.deepStrictEqual(urls("dana", gitlab), [], "not an address");

  assert.deepStrictEqual(urls("dana@example.com", other, settings({ mode: "remote+gravatar" })), [`https://www.gravatar.com/avatar/${sha256("dana@example.com")}?s=64&d=404`]);
  assert.deepStrictEqual(urls("dana@example.com", [...gitlab, ...github], settings({ mode: "remote+gravatar", urlTemplate: "https://avatars.acme.test/{md5}?s={size}" })), [
    "https://gitlab.acme.test/api/v4/avatar?email=dana%40example.com&size=64",
    `https://avatars.acme.test/${md5("dana@example.com")}?s=64`,
    `https://www.gravatar.com/avatar/${sha256("dana@example.com")}?s=64&d=404`,
  ], "remote hosts, then the user's template, then Gravatar");
  assert.deepStrictEqual(urls("dana@example.com", other, settings({ urlTemplate: "https://avatars.acme.test/{sha256}" })), [`https://avatars.acme.test/${sha256("dana@example.com")}`],
    "a template the user wrote is asked in remote mode too");
  assert.deepStrictEqual(urls("dana@example.com", [...gitlab, ...gitlab]), ["https://gitlab.acme.test/api/v4/avatar?email=dana%40example.com&size=64"], "each once");
  assert.deepStrictEqual(urls("dana@example.com", other, settings({ hosts: { "git.acme.test": "gitlab" } })), ["https://git.acme.test/api/v4/avatar?email=dana%40example.com&size=64"]);
  console.log("ok - sources: only the repository's own hosts by default; template, then Gravatar when chosen; off asks nothing");
}
{
  const s = avatarSources("dana@example.com", [{ scheme: "http", host: "gitlab.acme.test", port: "8080" }], settings())[0];
  assert.deepStrictEqual(s, { kind: "gitlab", url: "http://gitlab.acme.test:8080/api/v4/avatar?email=dana%40example.com&size=64", host: "gitlab.acme.test:8080",
    allow: ["gitlab.acme.test"], origin: "http://gitlab.acme.test:8080" });
  const g = avatarSources("1+dana@users.noreply.github.com", [{ scheme: "https", host: "github.com" }], settings())[0];
  assert.strictEqual(g.host, "avatars.githubusercontent.com", "its breaker is the host asked");
  console.log("ok - each source names the host its breaker belongs to and where its redirects may lead");
}
{
  assert.strictEqual(gravatarUrl(" Dana@Example.com "), `https://www.gravatar.com/avatar/${sha256("dana@example.com")}?s=64&d=404`);
  assert.strictEqual(sha256("dana@example.com").length, 64);
  assert.strictEqual(expandTemplate("https://avatars.acme.test/{md5}/{sha256}?e={email}&s={size}", "Dana@Example.com", 32),
    `https://avatars.acme.test/${md5("dana@example.com")}/${sha256("dana@example.com")}?e=dana%40example.com&s=32`);
  assert.strictEqual(expandTemplate("https://avatars.acme.test/logo.png", "dana@example.com"), undefined, "names no author");
  assert.strictEqual(expandTemplate("ftp://avatars.acme.test/{md5}", "dana@example.com"), undefined);
  assert.strictEqual(expandTemplate("https://user:pw@avatars.acme.test/{md5}", "dana@example.com"), undefined, "no credentials in a URL Linyra sends");
  assert.strictEqual(expandTemplate("https://avatars.acme.test/{md5}", "not an address"), undefined);
  console.log("ok - Gravatar by sha256 with d=404; the template's {md5} {sha256} {email} {size}");
}
{
  const origin = "https://gitlab.acme.test";
  assert.strictEqual(gitlabAvatar({ avatar_url: "https://gitlab.acme.test/uploads/-/system/user/avatar/7/avatar.png?width=64" }, origin),
    "https://gitlab.acme.test/uploads/-/system/user/avatar/7/avatar.png?width=64");
  assert.strictEqual(gitlabAvatar({ avatar_url: "/uploads/-/system/user/avatar/7/avatar.png" }, origin), "https://gitlab.acme.test/uploads/-/system/user/avatar/7/avatar.png", "relative to the instance");
  assert.strictEqual(gitlabAvatar({ avatar_url: "https://cdn.gitlab.acme.test/uploads/7/avatar.png" }, origin), "https://cdn.gitlab.acme.test/uploads/7/avatar.png", "the instance's own subdomain");
  for (const discarded of [
    `https://secure.gravatar.com/avatar/${md5("dana@example.com")}?s=64&d=identicon`,
    `https://www.gravatar.com/avatar/${md5("dana@example.com")}?s=64&d=identicon`,
    `https://seccdn.libravatar.org/avatar/${md5("dana@example.com")}?s=64&d=identicon`,
    "https://gitlab.acme.test/assets/no_avatar-849f9c04a3a0d0cea2424ae97b27447dc64a7dbfae83c036c45b403392f0e8ba.png",
    "/assets/no_avatar.png",
    "https://avatars.acme.test/7.png",
    "https://dana:pw@gitlab.acme.test/uploads/7/avatar.png",
    "javascript:alert(1)",
    "",
  ]) assert.strictEqual(gitlabAvatar({ avatar_url: discarded }, origin), undefined, discarded);
  for (const bad of [null, "x", 3, [], {}, { avatar_url: 7 }]) assert.strictEqual(gitlabAvatar(bad, origin), undefined);
  assert.strictEqual(gitlabAvatar({ avatar_url: "http://gitlab.acme.test/uploads/7/avatar.png" }, origin), undefined, "never down to http");
  console.log("ok - GitLab answers: its own uploads only; Gravatar, Libravatar, other hosts and its no_avatar placeholder are dropped");
}
{
  assert.deepStrictEqual(classify(200, undefined, "https://gitlab.acme.test/x"), { kind: "body" });
  assert.deepStrictEqual(classify(302, "/u/7?v=4", "https://avatars.githubusercontent.com/dana"), { kind: "redirect", url: "https://avatars.githubusercontent.com/u/7?v=4" });
  assert.deepStrictEqual(classify(302, "https://gitlab.acme.test/users/sign_in", "https://gitlab.acme.test/api/v4/avatar"), { kind: "refused" });
  assert.deepStrictEqual(classify(302, "https://login.acme.test/adfs?x=1", "https://gitlab.acme.test/api/v4/avatar"), { kind: "refused" });
  assert.deepStrictEqual(classify(302, undefined, "https://gitlab.acme.test/x"), { kind: "none" });
  for (const status of [401, 403, 407]) assert.deepStrictEqual(classify(status, undefined, "https://x.test/"), { kind: "refused" }, String(status));
  for (const status of [408, 429, 500, 502, 503]) assert.deepStrictEqual(classify(status, undefined, "https://x.test/"), { kind: "transient" }, String(status));
  for (const status of [404, 410, 400, 304]) assert.deepStrictEqual(classify(status, undefined, "https://x.test/"), { kind: "none" }, String(status));
  assert.ok(isSignIn("https://gitlab.acme.test/users/sign_in"));
  assert.ok(isSignIn("https://git.acme.test/login?return_to=%2Fdana.png"));
  assert.ok(isSignIn("https://sso.acme.test/"));
  assert.ok(isSignIn("https://idp.acme.test/saml2/idp/SSOService.php") && isSignIn("https://acme.test/oauth/authorize"));
  assert.ok(!isSignIn("https://avatars.githubusercontent.com/u/7?v=4"));
  assert.ok(!isSignIn("https://gitlab.acme.test/uploads/-/system/user/avatar/7/avatar.png"));
  assert.ok(!isSignIn(`https://www.gravatar.com/avatar/${sha256("x")}`));
  console.log("ok - answers: 401/403 and sign-in redirects refuse, 429/5xx are transient, 404 is no avatar");
}
{
  assert.ok(redirectAllowed("https://avatars.githubusercontent.com/dana", "https://avatars.githubusercontent.com/u/7", ["avatars.githubusercontent.com"]));
  assert.ok(redirectAllowed("https://github.acme.test/rin.png", "https://avatars.github.acme.test/u/7", ["github.acme.test"]), "the instance's subdomain");
  assert.ok(!redirectAllowed("https://github.acme.test/rin.png", "https://tracker.example/u/7", ["github.acme.test"]));
  assert.ok(!redirectAllowed("https://gitlab.acme.test/a.png", "http://gitlab.acme.test/a.png", ["gitlab.acme.test"]), "never down to http");
  assert.ok(redirectAllowed("http://gitlab.acme.test/a.png", "http://gitlab.acme.test/b.png", ["gitlab.acme.test"]), "an http instance stays http");
  assert.ok(redirectAllowed("https://gitlab.acme.test/uploads/a.png", "https://storage.acme.test/bucket/a.png?sig=1", ["*"]), "a GitLab image may come from its storage");
  assert.ok(!redirectAllowed("https://gitlab.acme.test/uploads/a.png", "http://storage.acme.test/a.png", ["*"]));
  assert.ok(!redirectAllowed("https://gitlab.acme.test/a", "https://u:p@gitlab.acme.test/a", ["gitlab.acme.test"]));
  assert.ok(!redirectAllowed("https://gitlab.acme.test/a", "file:///etc/passwd", ["*"]));
  console.log("ok - redirects: https, on the allowed hosts only (a GitLab image: any https host)");
}
{
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  assert.strictEqual(imageType(png), "image/png");
  assert.strictEqual(imageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.strictEqual(imageType(new TextEncoder().encode("GIF89a")), "image/gif");
  assert.strictEqual(imageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.strictEqual(imageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")), undefined, "no SVG");
  assert.strictEqual(imageType(new TextEncoder().encode("<!DOCTYPE html><title>Sign in</title>")), undefined);
  assert.strictEqual(imageType(new Uint8Array()), undefined);
  assert.strictEqual(dataUri(png), `data:image/png;base64,${Buffer.from(png).toString("base64")}`);
  assert.strictEqual(dataUri(new TextEncoder().encode("{}")), undefined);
  console.log("ok - a picture's type comes from its bytes: PNG, JPEG, GIF, WebP; anything else is no avatar");
}
{
  let b: Breaker = CLOSED;
  const t0 = 1_000_000;
  b = record(b, "transient", t0);
  b = record(b, "transient", t0);
  assert.deepStrictEqual(b, { state: "closed", failures: 2 });
  assert.ok(admit(b, t0).ok);
  b = record(b, "ok", t0);
  assert.deepStrictEqual(b, CLOSED, "an answer resets the count");
  for (let i = 0; i < BREAKER.failures; i++) b = record(b, "transient", t0);
  assert.deepStrictEqual(b, { state: "open", until: t0 + BREAKER.cooldownMs }, "three failures in a row open it");
  assert.ok(!admit(b, t0 + 1000).ok, "cooling down");
  assert.deepStrictEqual(record(b, "transient", t0 + 1000), b, "a request sent before it opened changes nothing");
  const probe = admit(b, t0 + BREAKER.cooldownMs);
  assert.ok(probe.ok);
  assert.deepStrictEqual(probe.next, { state: "probing" });
  assert.ok(!admit(probe.next, t0 + BREAKER.cooldownMs).ok, "one probe at a time");
  assert.deepStrictEqual(record(probe.next, "transient", t0 + BREAKER.cooldownMs), { state: "open", until: t0 + 2 * BREAKER.cooldownMs }, "a failed probe: another cooldown");
  assert.deepStrictEqual(record(probe.next, "ok", t0 + BREAKER.cooldownMs), CLOSED, "an answered probe closes it");
  for (const from of [CLOSED, b, probe.next] as Breaker[]) assert.deepStrictEqual(record(from, "refused", t0), { state: "broken" });
  const broken: Breaker = { state: "broken" };
  assert.ok(!admit(broken, Number.MAX_SAFE_INTEGER).ok, "broken: for the session");
  assert.deepStrictEqual(record(broken, "ok", t0), broken, "a late answer does not mend it");
  const all = new Breakers();
  assert.ok(all.admit("gitlab.acme.test", t0));
  assert.deepStrictEqual(all.record("gitlab.acme.test", "refused", t0), broken);
  assert.ok(!all.admit("gitlab.acme.test", t0) && all.admit("github.com", t0), "one host's breaker leaves the others");
  console.log("ok - circuit breaker: 3 failures open it for 5 minutes, then one probe; 401/403/sign-in break it for the session");
}
