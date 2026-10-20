// A three-way line merge with git merge-file's rule for clean versus conflict: changes to
// overlapping or adjacent base lines conflict unless both sides made the same change.
// Combined Changes uses it to take selected commits back out of a file, in memory.

export type MergeResult = { ok: true; text: string } | { ok: false };

/** Lines with their terminators, so joining them gives back the exact bytes (CRLF, no final newline). */
function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** One change against base: base[start, end) becomes `lines`. */
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}

/** Myers' O(ND) diff of a against b, as hunks over a. */
function diff(a: readonly string[], b: readonly string[]): Hunk[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  // Walk back to the edit path: a list of kept (a, b) pairs.
  const kept: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? 0) < (vd.get(k + 1) ?? 0)) ? k + 1 : k - 1;
    const prevX = vd.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) kept.push([--x, --y]);
    if (d > 0) {
      x = prevX;
      y = prevY;
    }
  }
  while (x > 0 && y > 0) kept.push([--x, --y]);
  kept.reverse();
  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  for (const [ka, kb] of [...kept, [n, m] as [number, number]]) {
    if (ka > ai || kb > bi) hunks.push({ start: ai, end: ka, lines: b.slice(bi, kb) });
    ai = ka + 1;
    bi = kb + 1;
  }
  return hunks;
}

/** One side's text for base[start, end), with its hunks inside that range applied. */
function sideText(base: readonly string[], hunks: readonly Hunk[], start: number, end: number): string[] {
  const out: string[] = [];
  let at = start;
  for (const h of hunks) {
    out.push(...base.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...base.slice(at, end));
  return out;
}

export function merge3(base: string, ours: string, theirs: string): MergeResult {
  const b = lines(base);
  const sides = [diff(b, lines(ours)), diff(b, lines(theirs))];
  const out: string[] = [];
  let at = 0;
  const next = [0, 0];
  for (;;) {
    // The next hunk on either side, then every hunk that overlaps or touches the group.
    const a = sides[0][next[0]];
    const t = sides[1][next[1]];
    if (!a && !t) break;
    const first = !t || (a && a.start <= t.start) ? 0 : 1;
    const group: Hunk[][] = [[], []];
    const head = sides[first][next[first]++];
    group[first].push(head);
    let start = head.start;
    let end = head.end;
    for (let grew = true; grew; ) {
      grew = false;
      for (const s of [0, 1]) {
        const h = sides[s][next[s]];
        if (h && h.start <= end) {
          group[s].push(h);
          next[s]++;
          start = Math.min(start, h.start);
          end = Math.max(end, h.end);
          grew = true;
        }
      }
    }
    out.push(...b.slice(at, start));
    const mine = sideText(b, group[0], start, end);
    const theirsText = sideText(b, group[1], start, end);
    if (group[0].length === 0) out.push(...theirsText);
    else if (group[1].length === 0) out.push(...mine);
    else if (mine.join("") === theirsText.join("")) out.push(...mine);
    else return { ok: false };
    at = end;
  }
  out.push(...b.slice(at));
  return { ok: true, text: out.join("") };
}
