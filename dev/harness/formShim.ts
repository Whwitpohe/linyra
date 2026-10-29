import type { FormHost, FormWebview } from "../../src/formModel";
import { releaseSpec } from "../../src/releaseModel";
import { configureI18n } from "../../src/i18n";

// A review form (Release…, Tag Across Repositories…) with neutral fixtures. ?form=release|tag;
// ?refuse=tag: the host refuses the tag on submit (a repository already has it).
const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
document.getElementById("theme")!.setAttribute("href", `themes/${theme}.css`);
document.body.classList.add(theme === "hc-dark" ? "vscode-high-contrast" : theme === "hc-light" ? "vscode-high-contrast-light" : `vscode-${theme}`);
// The page's own strings follow its locale; the spec is built here, in the same one.
const i18n = document.getElementById("linyra-i18n")?.textContent;
if (i18n) { const v = JSON.parse(i18n) as { language: string; bundle?: Record<string, string> }; configureI18n(v.language, v.bundle); }

const notes = `## acme-web (develop → main)

- feat(web): sign in with a passkey (1a2b3c4)
- fix(web): keep the login callback on preview builds (5d6e7f8)

## acme-api (develop → main)

- feat(api): retry the upload once (9a8b7c6)`;

const release = releaseSpec({
  from: "develop", into: "main", notes, push: true,
  rows: [
    { id: "acme-web", name: "acme-web", from: "develop", into: "main", commits: 4, how: "checked out: git merge" },
    { id: "acme-api", name: "acme-api", from: "origin/develop", into: "main", commits: 2, how: "not checked out: your working tree is not touched", noUpstream: true },
  ],
  left: [{ name: "acme-libs", reason: "would conflict" }],
});

const tag = {
  id: "tagAcross", title: "Tag Across Repositories", intro: "One tag on the checked-out commit of each repository you keep ticked.",
  fields: [
    { kind: "text", id: "name", label: "Tag name", placeholder: "for example v1.4.0", rule: "ref" },
    { kind: "text", id: "message", label: "Message (optional)", multiline: true, placeholder: "Release notes, or nothing", hint: "With a message, git records who made the tag and when." },
    { kind: "check", id: "push", label: "Push the tag to each repository's remote", value: true },
    { kind: "list", id: "repos", label: "Repositories", required: "Tick at least one repository.", items: [
      { id: "acme-web", label: "acme-web", description: "main", value: true },
      { id: "acme-api", label: "acme-api", description: "origin/release-1.4", value: true },
      { id: "acme-libs", label: "acme-libs", value: false, disabled: "its branches could not be read" },
    ] },
  ],
  submit: "Create Tag", cancel: "Cancel",
} as const;

const spec = params.get("form") === "tag" ? tag : release;
const send = (data: FormHost) => window.dispatchEvent(new MessageEvent("message", { data }));
const host = window as unknown as { acquireVsCodeApi(): unknown; formMessages: FormWebview[] };
host.formMessages = [];
host.acquireVsCodeApi = () => ({
  postMessage(m: FormWebview) {
    host.formMessages.push(m);
    if (m.type === "ready") setTimeout(() => send({ type: "spec", spec: JSON.parse(JSON.stringify(spec)) }), 0);
    if (m.type === "submit" && params.get("refuse") === "tag") setTimeout(() => send({ type: "problems", problems: { tag: "acme-web already has the tag v1.4.0." } }), 50);
  },
});
