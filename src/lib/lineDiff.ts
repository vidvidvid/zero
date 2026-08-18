import { Change, diff } from "@codemirror/merge";

/**
 * Diffing by lines, which is what everyone else means by "diff".
 *
 * `@codemirror/merge` diffs *characters* across the whole document, and that
 * is the wrong shape for a file. Its own guard against the cost — `scanLimit`,
 * 500 by default — gives up once the changed span passes about 16,000
 * characters and returns one change covering all of it, so eight scattered
 * edits in a 3,700-line file come back as a single chunk spanning 80% of the
 * file. Nothing downstream can then tell which lines actually changed: the
 * viewport cull in diffChars has one chunk to cull and it is always on screen,
 * so every scroll re-ran a character diff over the entire file. Measured on
 * App.css that was 9 seconds a frame at 663 changed lines.
 *
 * Git has the answer and has had it since 1986: run Myers over *lines*, not
 * characters. The input shrinks by the width of a line and the edit distance
 * shrinks with it, which is the difference between quadratic on 100,000
 * characters and quadratic on 3,700 lines — 9 seconds becomes 22 milliseconds,
 * and the chunks come out per hunk the way GitHub shows them. Checked against
 * `git diff` over 19 file pairs from this repository's history: same number of
 * hunks in every one, at exactly git's line ranges in 16, the rest within a
 * line or two where git's indent heuristic slides a boundary onto a blank
 * line.
 *
 * The implementation is the standard trick rather than a second Myers: give
 * every distinct line a character of its own, and the existing character diff
 * *is* a line diff. `diff` is fed through `DiffConfig.override`, which the
 * package documents for exactly this.
 */

// One code point per distinct line, starting past the ASCII range and stepping
// over the surrogate block — a lone surrogate is not a character and would not
// survive the round trip through a JS string.
const FIRST_CODE = 0x100;
const SURROGATES = [0xd800, 0xdfff] as const;

/** Precise to about 2,500 changed lines — past that (a file more than half
 *  rewritten) it falls back to the package's coarse match, which is still
 *  line-granular. The timeout is the backstop for a pathological file. */
const LINE_DIFF = { scanLimit: 5000, timeout: 500 };

interface Encoded {
  /** one character per line */
  text: string;
  /** where each line starts, with the document's length appended */
  offsets: number[];
}

/**
 * A line here *includes* its newline, and the last line of a file that doesn't
 * end in one is therefore a different line from the same text that does.
 *
 * Splitting on the newline instead and treating it as a separator looks
 * equivalent and isn't: `"}\n"` splits into `["}", ""]` and `"}"` into `["}"]`,
 * so dropping a file's final newline reads as deleting an empty line that
 * begins and ends at the end of the document — a change with nowhere to be,
 * which the character offsets then quietly lose. Owning the newline makes it
 * a change to the last line, which is what it is, and what git calls
 * "\ No newline at end of file".
 */
function encode(text: string, ids: Map<string, number>, next: { code: number }): Encoded {
  const codes: string[] = [];
  const offsets: number[] = [];
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl + 1;
    const line = text.slice(pos, end);
    let id = ids.get(line);
    if (id === undefined) {
      if (next.code >= SURROGATES[0] && next.code <= SURROGATES[1]) next.code = SURROGATES[1] + 1;
      id = next.code++;
      ids.set(line, id);
    }
    codes.push(String.fromCharCode(id));
    offsets.push(pos);
    pos = end;
  }
  offsets.push(text.length);
  return { text: codes.join(""), offsets };
}

/** A line-level diff, in character offsets. Drop-in for `DiffConfig.override`. */
export function lineDiff(a: string, b: string): readonly Change[] {
  const ids = new Map<string, number>();
  const next = { code: FIRST_CODE };
  const ea = encode(a, ids, next);
  const eb = encode(b, ids, next);
  // More distinct lines than there are code points to name them with. Nothing
  // real gets here — it would take 65,000 distinct lines across the two sides
  // — but the encoding would silently collide, so hand it back to the
  // character diff rather than return a wrong answer.
  if (next.code > 0xffff) return diff(a, b, { scanLimit: 500 });
  return diff(ea.text, eb.text, LINE_DIFF).map(
    (c) =>
      new Change(ea.offsets[c.fromA], ea.offsets[c.toA], eb.offsets[c.fromB], eb.offsets[c.toB])
  );
}
