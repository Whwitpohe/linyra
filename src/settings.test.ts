import * as assert from "assert";
import { DEFAULT_AVATAR_SETTINGS, DEFAULT_SETTINGS, avatarMode, readAvatarSettings, readSettings } from "./settings";

const from = (m: Record<string, unknown>) => readSettings((k) => m[k]);

{
  assert.deepStrictEqual(from({}), DEFAULT_SETTINGS);
  assert.deepStrictEqual(DEFAULT_SETTINGS, { pageSize: 200, maxConcurrency: 16, scanDepth: 2, excludeRepos: [] });
  console.log("ok - unset settings use the spec defaults");
}
{
  assert.deepStrictEqual(from({ pageSize: 0, maxConcurrency: 1e9, scanDepth: -3, excludeRepos: ["acme-libs", 4, null] }), {
    pageSize: 1, maxConcurrency: 64, scanDepth: 0, excludeRepos: ["acme-libs"],
  });
  assert.deepStrictEqual(from({ pageSize: "lots", maxConcurrency: NaN, scanDepth: 2.6, excludeRepos: "acme-*" }), {
    pageSize: 200, maxConcurrency: 16, scanDepth: 3, excludeRepos: [],
  });
  console.log("ok - out-of-range values clamp, wrong types fall back to defaults");
}
{
  const avatars = (m: Record<string, unknown>, workspace?: unknown[]) => readAvatarSettings((k) => m[k], workspace);
  assert.deepStrictEqual(avatars({}), DEFAULT_AVATAR_SETTINGS);
  assert.deepStrictEqual(DEFAULT_AVATAR_SETTINGS, { mode: "remote", hosts: {}, urlTemplate: "" }, "by default only the remote hosts are asked");
  assert.strictEqual(avatars({ avatars: "remote+gravatar" }).mode, "remote+gravatar");
  assert.strictEqual(avatars({ avatars: "off" }).mode, "off");
  assert.strictEqual(avatars({ avatars: "gravatar" }).mode, "remote", "an unknown mode falls back to the default");
  console.log("ok - linyra.avatars: off, remote (the default), remote+gravatar");
}
{
  // A cloned repository's .vscode/settings.json must not send its authors' addresses further.
  assert.strictEqual(avatarMode(undefined, ["remote+gravatar"]), "remote", "a workspace cannot turn Gravatar on");
  assert.strictEqual(avatarMode("remote", ["remote+gravatar"]), "remote");
  assert.strictEqual(avatarMode("remote+gravatar", ["remote"]), "remote", "a workspace can narrow");
  assert.strictEqual(avatarMode("remote+gravatar", [undefined, "off"]), "off", "a workspace folder can turn avatars off");
  assert.strictEqual(avatarMode("remote+gravatar", [undefined, "bogus"]), "remote+gravatar", "unset or unknown workspace values change nothing");
  console.log("ok - a workspace can turn avatars off or narrow them, never ask more servers");
}
{
  const { hosts } = readAvatarSettings((k) => k === "avatarHosts" ? {
    "GitLab.Acme.Test": "gitlab", "https://git.acme.test/": "github", "git.acme.test:8443": "gitlab",
    "bad host": "gitlab", "acme.test": "bitbucket", "__proto__": "gitlab", "x": 3,
  } : undefined);
  assert.deepStrictEqual(hosts, { "gitlab.acme.test": "gitlab", "git.acme.test": "github", "git.acme.test:8443": "gitlab" });
  assert.deepStrictEqual(readAvatarSettings((k) => k === "avatarHosts" ? ["gitlab.acme.test"] : undefined).hosts, {});
  console.log("ok - linyra.avatarHosts: host or host:port, lowercased, gitlab or github only");
}
{
  const template = (v: unknown) => readAvatarSettings((k) => k === "avatarUrlTemplate" ? v : undefined).urlTemplate;
  assert.strictEqual(template(" https://avatars.acme.test/{md5}?s={size} "), "https://avatars.acme.test/{md5}?s={size}");
  assert.strictEqual(template("http://avatars.acme.test/a/{sha256}"), "http://avatars.acme.test/a/{sha256}");
  assert.strictEqual(template("https://avatars.acme.test/{email}"), "https://avatars.acme.test/{email}");
  assert.strictEqual(template("https://avatars.acme.test/logo.png?s={size}"), "", "the same picture for every author is no avatar");
  assert.strictEqual(template("file:///avatars/{md5}"), "");
  assert.strictEqual(template("javascript:{md5}"), "");
  assert.strictEqual(template(42), "");
  console.log("ok - linyra.avatarUrlTemplate: http(s), and it must name the author");
}
