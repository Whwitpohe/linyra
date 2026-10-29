// Visual History's geometry: bubble sizes, author rows, time ticks and keyboard moves. Pure.

/**
 * The radius for a commit's lines changed: area grows with lines (radius with their square root),
 * from `min` (one line, or none: a rename, a binary) to `max`. The scale tops out at the 95th
 * percentile, so one vendored import does not shrink every other bubble to a dot.
 */
export function radiusScale(lines: readonly number[], min: number, max: number): (n: number) => number {
  const sorted = lines.filter((n) => n > 0).sort((a, b) => a - b);
  const cap = Math.max(1, sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 1);
  return (n) => {
    if (!(n > 0)) return min;
    return min + (max - min) * Math.sqrt(Math.min(n, cap) / cap);
  };
}

/**
 * The radii a chart can afford: at most half a row, and smaller as the busiest row crowds its
 * width (a year of one author's daily commits would otherwise be one smear).
 */
export function bubbleRange(busiestRow: number, plotWidth: number, rowHeight: number): { min: number; max: number } {
  const spacing = plotWidth / Math.max(1, busiestRow);
  const max = Math.max(3, Math.min(22, rowHeight / 2 - 2, spacing * 2));
  return { min: Math.min(3, Math.max(1.5, max / 3)), max };
}

export interface AuthorRow {
  /** The lowercased email (the name when there is none): one row per person. */
  key: string;
  name: string;
  email: string;
  count: number;
  /** The repository with most of their commits in view (the disc's ring when colored by repository). */
  topRepo: string;
}

export const authorKey = (name: string, email: string): string => (email.trim() || name.trim()).toLowerCase();

/** One row per author, most commits first (then by name), each with their busiest repository. */
export function authorRows(commits: readonly { author: string; email: string; repoId: string }[]): AuthorRow[] {
  const rows = new Map<string, AuthorRow & { repos: Map<string, number> }>();
  for (const c of commits) {
    const key = authorKey(c.author, c.email);
    let row = rows.get(key);
    if (!row) rows.set(key, (row = { key, name: c.author, email: c.email, count: 0, topRepo: c.repoId, repos: new Map() }));
    row.count++;
    row.repos.set(c.repoId, (row.repos.get(c.repoId) ?? 0) + 1);
  }
  return [...rows.values()]
    .map(({ repos, ...row }) => ({ ...row, topRepo: [...repos].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0] }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export type TickUnit = "day" | "week" | "month" | "quarter" | "year";
export interface Tick { time: number; unit: TickUnit }

const DAY = 86_400;
/** Candidate steps, finest first: [unit, how many]. */
const STEPS: [TickUnit, number][] = [["day", 1], ["day", 2], ["week", 1], ["week", 2], ["month", 1], ["quarter", 1], ["month", 6], ["year", 1], ["year", 2], ["year", 5], ["year", 10]];

function approx(unit: TickUnit, n: number): number {
  return n * (unit === "day" ? DAY : unit === "week" ? 7 * DAY : unit === "month" ? 30.4 * DAY : unit === "quarter" ? 91.3 * DAY : 365.25 * DAY);
}

/** The first boundary at or after `t` (local calendar): midnight, Monday, the 1st, a quarter, a year. */
function boundary(t: number, unit: TickUnit, n: number): Date {
  const d = new Date(t * 1000);
  d.setHours(0, 0, 0, 0);
  if (unit === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  if (unit === "month" || unit === "quarter") {
    d.setDate(1);
    const every = unit === "quarter" ? 3 : n;
    d.setMonth(Math.floor(d.getMonth() / every) * every);
  }
  if (unit === "year") { d.setMonth(0, 1); d.setFullYear(Math.floor(d.getFullYear() / n) * n); }
  while (d.getTime() / 1000 < t) step(d, unit, n);
  return d;
}

function step(d: Date, unit: TickUnit, n: number): void {
  if (unit === "day") d.setDate(d.getDate() + n);
  else if (unit === "week") d.setDate(d.getDate() + 7 * n);
  else if (unit === "month") d.setMonth(d.getMonth() + n);
  else if (unit === "quarter") d.setMonth(d.getMonth() + 3 * n);
  else d.setFullYear(d.getFullYear() + n);
}

/** Calendar ticks between two moments, at least `minGap` px apart on a `width` px axis. */
export function timeTicks(from: number, to: number, width: number, minGap = 84): Tick[] {
  if (!(to > from) || width <= 0) return [];
  const span = to - from;
  const fit = Math.max(1, Math.floor(width / minGap));
  const [unit, n] = STEPS.find(([u, k]) => span / approx(u, k) <= fit) ?? STEPS[STEPS.length - 1];
  const ticks: Tick[] = [];
  const d = boundary(from, unit, n);
  for (let i = 0; i < 200 && d.getTime() / 1000 <= to; i++) {
    ticks.push({ time: Math.floor(d.getTime() / 1000), unit });
    step(d, unit, n);
  }
  return ticks;
}

/** The time axis: what [from, to] spans. All of history runs from the oldest commit drawn. */
export function timeDomain(since: number | undefined, now: number, times: readonly number[]): [number, number] {
  // A loop, not Math.min(...times): a spread of 100,000 arguments overflows the stack.
  let oldest = times.length ? Infinity : now - 7 * DAY, newest = now;
  for (const t of times) {
    if (t < oldest) oldest = t;
    if (t > newest) newest = t;
  }
  const from = since ?? oldest;
  // A little room either side, so the first and last bubbles are not cut in half.
  const pad = Math.max(3600, (now - from) * 0.01);
  return [Math.min(from, oldest) - pad, newest + pad];
}

/** Each author row's commits, oldest first (indexes into the drawn list): the keyboard walks these. */
export function rowOrder(rowOf: readonly number[], times: readonly number[], rows: number): number[][] {
  const order: number[][] = Array.from({ length: rows }, () => []);
  rowOf.forEach((row, i) => order[row]?.push(i));
  for (const list of order) list.sort((a, b) => times[a] - times[b] || a - b);
  return order;
}

export type MoveKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

/**
 * The commit a key moves to: ←/→ along the row in time, ↑/↓ the nearest in time on the next row
 * that has any, Home/End the row's oldest/newest. From nothing focused: the newest commit of the top row.
 */
export function moveFocus(order: readonly (readonly number[])[], times: readonly number[], rowOf: readonly number[], current: number | undefined, key: MoveKey): number | undefined {
  if (current === undefined || rowOf[current] === undefined) {
    const first = order.find((list) => list.length > 0);
    return first ? first[first.length - 1] : undefined;
  }
  const row = rowOf[current];
  const list = order[row];
  const at = list.indexOf(current);
  switch (key) {
    case "ArrowLeft": return list[Math.max(0, at - 1)];
    case "ArrowRight": return list[Math.min(list.length - 1, at + 1)];
    case "Home": return list[0];
    case "End": return list[list.length - 1];
    case "ArrowUp":
    case "ArrowDown": {
      const dir = key === "ArrowUp" ? -1 : 1;
      for (let r = row + dir; r >= 0 && r < order.length; r += dir) {
        if (order[r].length === 0) continue;
        let best = order[r][0];
        for (const i of order[r]) if (Math.abs(times[i] - times[current]) < Math.abs(times[best] - times[current])) best = i;
        return best;
      }
      return current;
    }
  }
}
