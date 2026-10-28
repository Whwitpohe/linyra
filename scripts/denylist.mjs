// Pure matching for the denylist check. The entries themselves never appear in
// this repository: CI reads them from the LINYRA_DENYLIST secret, a developer
// machine from the gitignored .denylist file.

/** Newline- or comma-separated entries; a line starting with `#` is a comment. */
export function parsePatterns(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .flatMap((line) => line.split(","))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Every line containing an entry, case-insensitively. A hit names the entry by
 * its 1-based index, never by the word itself, because CI logs are public.
 */
export function findHits(text, patterns) {
  const hits = [];
  text.toLowerCase().split("\n").forEach((line, i) => {
    patterns.forEach((p, j) => {
      if (line.includes(p)) hits.push({ line: i + 1, entry: j + 1 });
    });
  });
  return hits;
}
