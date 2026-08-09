/**
 * Fuzzy path matching for quick open.
 *
 * A query matches if its characters appear in order somewhere in the path — so
 * `wsp` finds `components/Workspace.tsx`. What separates a good match from a
 * technically-correct one is where those characters landed, so the score is
 * built from bonuses rather than counting hits: a run of consecutive letters is
 * worth far more than the same letters scattered, the filename beats the
 * directories leading to it, and the start of a word beats the middle of one.
 */

const WORD_BREAK = /[/\\\-_. ]/;

function isUpper(ch: string) {
  return ch >= "A" && ch <= "Z";
}

function isLower(ch: string) {
  return ch >= "a" && ch <= "z";
}

/** Higher is better. `null` means the query doesn't appear in order at all. */
export function fuzzyScore(path: string, query: string): number | null {
  if (!query) return 0;
  const hay = path.toLowerCase();
  const needle = query.toLowerCase();

  const baseAt = path.lastIndexOf("/") + 1;
  let qi = 0;
  let total = 0;
  let run = 0;

  for (let i = 0; i < hay.length && qi < needle.length; i++) {
    if (hay[i] !== needle[qi]) {
      run = 0;
      continue;
    }
    let points = 1;
    if (i >= baseAt) points += 3; // in the filename, not the path to it
    if (i === baseAt) points += 5; // the filename's first letter
    const prev = i > 0 ? path[i - 1] : "/";
    if (WORD_BREAK.test(prev)) points += 4;
    else if (isLower(prev) && isUpper(path[i])) points += 3; // camelCase hump
    run += 1;
    points += run * 2; // consecutive letters are what "looks right"
    total += points;
    qi += 1;
  }

  if (qi < needle.length) return null;
  // among equally good matches, the shorter path is nearly always the one meant
  return total - path.length * 0.05;
}

export interface Ranked {
  path: string;
  score: number;
}

export function rankPaths(paths: string[], query: string, limit: number): Ranked[] {
  if (!query.trim()) return paths.slice(0, limit).map((path) => ({ path, score: 0 }));
  const out: Ranked[] = [];
  for (const path of paths) {
    const score = fuzzyScore(path, query);
    if (score !== null) out.push({ path, score });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return out.slice(0, limit);
}

/** The indices the query matched, for underlining them in the list. */
export function matchedIndices(path: string, query: string): Set<number> {
  const hit = new Set<number>();
  if (!query) return hit;
  const hay = path.toLowerCase();
  const needle = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < hay.length && qi < needle.length; i++) {
    if (hay[i] === needle[qi]) {
      hit.add(i);
      qi += 1;
    }
  }
  return qi < needle.length ? new Set() : hit;
}
