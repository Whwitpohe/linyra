import "./authorDisc.css";
import { initials } from "../../initials";
import { h } from "../dom";

/**
 * Who made a commit, as a small disc: the author's initial in the theme's text color on a tint of
 * the repository's color, ringed in that color (a thicker ring: my commit). A real avatar, once
 * the host resolved one (setAvatars), covers the initial. One look in the graph and the hover card.
 */
const SVG_NS = "http://www.w3.org/2000/svg";
const avatars = new Map<string, string>();
const listeners = new Set<(changed: ReadonlySet<string>) => void>();

export const avatarKey = (email: string): string => email.trim().toLowerCase();

/** Avatars the host resolved (email → data: URI). Listeners hear once per batch, with the emails (avatarKey) that changed. */
export function setAvatars(byEmail: Record<string, string>): void {
  const changed = new Set<string>();
  for (const [email, uri] of Object.entries(byEmail)) {
    if (avatars.get(avatarKey(email)) === uri) continue;
    avatars.set(avatarKey(email), uri);
    changed.add(avatarKey(email));
  }
  if (changed.size > 0) for (const listener of listeners) listener(changed);
}

export function avatarFor(email: string): string | undefined {
  return avatars.get(avatarKey(email));
}

/** Called after setAvatars changed something: redraw what shows these authors' discs. */
export function onAvatars(listener: (changed: ReadonlySet<string>) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface DiscOptions { name: string; email: string; accent: number; mine?: boolean }

/** The disc inside a graph row's SVG, centred on (cx, cy). Three nodes at most: rows stay light. */
export function authorDiscSvg(o: DiscOptions, cx: number, cy: number, r = 7.5): SVGGElement {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", `author-disc accent-${o.accent}${o.mine ? " mine" : ""}`);
  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("class", "author-disc-ring");
  circle.setAttribute("cx", String(cx));
  circle.setAttribute("cy", String(cy));
  circle.setAttribute("r", String(r));
  g.append(circle);
  const avatar = avatarFor(o.email);
  if (avatar) {
    const image = document.createElementNS(SVG_NS, "image");
    image.setAttribute("class", "author-disc-image");
    image.setAttribute("href", avatar);
    image.setAttribute("x", String(cx - r + 1));
    image.setAttribute("y", String(cy - r + 1));
    image.setAttribute("width", String(2 * r - 2));
    image.setAttribute("height", String(2 * r - 2));
    g.append(image);
  } else {
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("class", "author-disc-initial");
    text.setAttribute("x", String(cx));
    text.setAttribute("y", String(cy + 0.5));
    text.textContent = initials(o.name);
    g.append(text);
  }
  return g;
}

/** The same disc as HTML (hover card, details), `size` px wide. */
export function authorDiscHtml(o: DiscOptions, size = 32): HTMLElement {
  const disc = h("span", { class: `author-disc-html accent-${o.accent}${o.mine ? " mine" : ""}`, "aria-hidden": "true" });
  disc.style.setProperty("--disc-size", `${size}px`);
  const avatar = avatarFor(o.email);
  disc.append(avatar ? h("img", { class: "author-disc-image", src: avatar, alt: "" }) : initials(o.name));
  return disc;
}
