import "./pill.css";
import { localize } from "../../i18n";
import { codiconElement, type Codicon } from "../codicons";
import { h } from "../dom";

/**
 * One part of a branch pill. A local branch and the remotes whose branch of the same name points
 * at the same commit share one pill ("develop | origin"), as GitLens and the JetBrains Log show
 * them; the current branch carries its distance from its upstream; a merge target is its own part.
 */
export interface PillSegment {
  kind: "local" | "remote" | "tag" | "base" | "detached";
  label: string;
  title?: string;
  /** The checked-out branch: drawn stronger. */
  current?: boolean;
  /** Distance from the upstream (local, current branch only); shown when not zero. */
  ahead?: number;
  behind?: number;
  /** Has no upstream at all ("unpublished"). */
  unpublished?: boolean;
}

const ICONS: Record<PillSegment["kind"], Codicon> = { local: "git-branch", remote: "cloud", tag: "tag", base: "target", detached: "git-commit" };

/** "↑2 ↓1", "", or "unpublished": a current branch's upstream state as text. */
export function upstreamText(s: Pick<PillSegment, "ahead" | "behind" | "unpublished">): string {
  if (s.unpublished) return localize("unpublished");
  return [s.ahead ? `↑${s.ahead}` : "", s.behind ? `↓${s.behind}` : ""].filter(Boolean).join(" ");
}

/**
 * A branch pill: its parts side by side in one rounded box, each with its icon. `context` becomes
 * the pill's data-vscode-context (right-click: the branch's menu, package.json webview/context).
 */
export function renderPill(segments: readonly PillSegment[], context?: Record<string, unknown>, className = ""): HTMLElement {
  const title = segments.map((s) => s.title ?? s.label).join(" · ");
  const pill = h("span", {
    class: `pill${segments.some((s) => s.current) ? " pill-current" : ""} pill-${segments[0]?.kind ?? "local"}${className ? ` ${className}` : ""}`,
    title, "aria-label": title,
    "data-vscode-context": context ? JSON.stringify({ preventDefaultContextMenuItems: true, ...context }) : undefined,
  });
  for (const s of segments) {
    const status = s.kind === "local" && s.current ? upstreamText(s) : "";
    pill.append(h("span", { class: `pill-part pill-${s.kind}` }, [
      codiconElement(ICONS[s.kind], "pill-icon"),
      h("span", { class: "pill-label" }, [s.label]),
      status ? h("span", { class: "pill-status" }, [status]) : null,
    ]));
  }
  return pill;
}
