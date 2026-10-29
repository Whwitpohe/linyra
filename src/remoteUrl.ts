/**
 * A commit's web page from a remote URL, for "Open on Remote". Pure: no vscode import.
 * The remote comes from repository config, so it is untrusted: only an http(s) page on the
 * remote's own host is ever built, never with userinfo (a token, or an "a@b" look-alike host).
 */

/** A SHA-1 or SHA-256 commit id. */
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** A plain host name (no userinfo, brackets, backslashes or spaces). */
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
/** Path segments as forges name repositories; no "." or ".." segment, no spaces. */
const SEGMENT = /^[A-Za-z0-9._~%+-]+$/;

interface Remote { scheme: "https" | "http"; host: string; port?: string; path: string }

function parseRemote(url: string): Remote | undefined {
  const u = url.trim();
  if (/^[a-z]:[\\/]/i.test(u)) return undefined; // a Windows path (C:\repos\x.git), not host:path
  // scp-like ssh: [user@]host:owner/repo.git (git's own rule: no "://", a colon before any slash).
  const scp = /^(?:[^@/\s]+@)?([^@:/\s[\]\\]+):(?!\/)(.+)$/.exec(u);
  if (scp && !u.includes("://")) return { scheme: "https", host: scp[1], path: scp[2] };
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol.replace(/:$/, "");
  if (scheme === "ssh" || scheme === "git" || scheme === "git+ssh") return { scheme: "https", host: parsed.hostname, path: parsed.pathname };
  // An http(s) port is the web server's; an ssh port is not. Userinfo is never kept.
  if (scheme === "https" || scheme === "http") return { scheme, host: parsed.hostname, port: parsed.port || undefined, path: parsed.pathname };
  return undefined; // file://, ext::, a local path
}

/**
 * The web server behind a remote (avatars ask it): https for ssh and scp-like remotes, whose port
 * is ssh's; scheme and port as written for http(s). Never userinfo. null for a local path.
 */
export function remoteHost(remoteUrl: string): { scheme: "https" | "http"; host: string; port?: string } | null {
  const r = parseRemote(remoteUrl);
  if (!r || !HOST.test(r.host)) return null;
  return { scheme: r.scheme, host: r.host.toLowerCase(), ...(r.port ? { port: r.port } : {}) };
}

export function commitWebUrl(remoteUrl: string, sha: string): string | null {
  if (!SHA.test(sha)) return null;
  const r = parseRemote(remoteUrl);
  if (!r || !HOST.test(r.host)) return null;
  const segments = r.path.replace(/\.git\/?$/i, "").split("/").filter((s) => s !== "");
  if (segments.length === 0 || segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) return null;
  const path = segments.join("/");
  const host = r.host.toLowerCase();
  const base = `${r.scheme}://${host}${r.port ? `:${r.port}` : ""}`;
  // Azure DevOps over ssh: ssh.dev.azure.com:v3/org/project/repo (vs-ssh.visualstudio.com, older).
  const azureSsh = /^v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
  if ((host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") && azureSsh) return `https://dev.azure.com/${azureSsh[1]}/${azureSsh[2]}/_git/${azureSsh[3]}/commit/${sha}`;
  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) return `${base}/${path}/commit/${sha}`;
  if (host === "bitbucket.org") return `${base}/${path}/commits/${sha}`;
  if (host === "gitlab.com" || host.startsWith("gitlab.")) return `${base}/${path}/-/commit/${sha}`;
  // GitHub, Gitea, Forgejo and most others.
  return `${base}/${path}/commit/${sha}`;
}
