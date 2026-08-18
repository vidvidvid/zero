import { EditorView, layer, RectangleMarker } from "@codemirror/view";
import { EditorSelection, Text } from "@codemirror/state";
import { diff, getChunks } from "@codemirror/merge";

/**
 * Char-level diff marks, standing in for the merge view's own highlighting
 * (which DiffView turns off with `highlightChanges: false`). The shape they
 * take is copied from how VS Code's diff editor reads:
 *
 * - Only chunks that *modify* lines get char marks. A chunk that purely adds
 *   or removes lines is already told by its line wash; marking its whole text
 *   as "changed" too (which stock does) turns every insertion into a solid
 *   double-tinted block.
 * - The marks come from the raw character diff — stock uses `presentableDiff`,
 *   which grows every change out to word boundaries, so `useState` → `State`
 *   reads as one whole word replacing another instead of `use` being deleted —
 *   but with VS Code's word heuristic on top: a change that covers most of the
 *   word it sits in extends to the whole word on both sides, so a word swapped
 *   for another doesn't read as surgery on its letters (see [`smartChanges`]).
 * - Two changes with only a short run of common text between them are one
 *   change. A raw character diff is happy to call `save` → `cancel` three
 *   separate edits because it found the `a` and the `e` in both, and marking
 *   them that way is the disconnected-letters read (see [`smartChanges`]).
 * - And a line marked nearly end to end is marked all the way. A rewritten
 *   sentence keeps a scattering of common words — `the`, `per domain`, a
 *   plural `s` — and drawing around them says the line was picked at rather
 *   than replaced (see the fill in [`changedRanges`]).
 *
 * They are drawn as a layer — the machinery selections are painted with —
 * rather than mark decorations, because an inline span's background stops at
 * the font's content box and leaves a sliver of leading between marked lines.
 * `RectangleMarker.forRange` measures from glyph coordinates and inherits the
 * same sliver, so each rectangle is then snapped out to the full line height
 * (see [`fullLineHeight`]); marks on consecutive lines meet exactly, the way
 * VS Code draws its full-height char boxes.
 *
 * Each side needs the opposite document to diff against, and `other` fetches
 * it from the MergeView — which doesn't exist yet while its editors (and so
 * this layer) are being constructed. Hence the nullable return, and the empty
 * poke DiffView dispatches to both sides right after construction; `ready`
 * keeps redrawing until the first build that could actually see across.
 */
export function charDiff(other: () => Text | null) {
  let ready = false;
  return layer({
    above: false,
    class: "cm-changedTextLayer",
    markers(view) {
      const otherDoc = other();
      ready = otherDoc !== null;
      return changedRanges(view, otherDoc).flatMap((r) =>
        fullLineHeight(
          view,
          RectangleMarker.forRange(view, "cm-changedText", EditorSelection.range(r.from, r.to))
        )
      );
    },
    update(u) {
      return (
        !ready ||
        u.docChanged ||
        u.viewportChanged ||
        u.geometryChanged ||
        getChunks(u.state)?.chunks !== getChunks(u.startState)?.chunks
      );
    },
  });
}

/** A CSS line box centres the text box inside its leading, so growing each
 *  rectangle symmetrically to the line height lands it exactly on the line's
 *  edges. Rectangles already taller than a line (there shouldn't be any — the
 *  ranges are split per line) pass through untouched. */
function fullLineHeight(view: EditorView, markers: readonly RectangleMarker[]) {
  const lh = view.defaultLineHeight;
  return markers.map((m) =>
    m.height < lh
      ? new RectangleMarker("cm-changedText", m.left, m.top - (lh - m.height) / 2, m.width, lh)
      : m
  );
}

function changedRanges(view: EditorView, otherDoc: Text | null): { from: number; to: number }[] {
  const info = getChunks(view.state);
  if (!info || !info.side || !otherDoc) return [];
  const isA = info.side === "a";
  const doc = view.state.doc;
  const { from: vFrom, to: vTo } = view.viewport;
  const byLine = new Map<number, { from: number; to: number }[]>();

  for (const chunk of info.chunks) {
    // pure insertions and deletions keep their flat line wash
    if (chunk.fromA >= chunk.toA || chunk.fromB >= chunk.toB) continue;
    // geometry is only measurable (and only needed) inside the viewport
    if ((isA ? chunk.fromA : chunk.fromB) > vTo || (isA ? chunk.endA : chunk.endB) < vFrom)
      continue;
    // A chunk this size is a rewritten region, not an edit, and marking
    // letters inside it says nothing its line wash hasn't already said. It is
    // also the only place left where the character diff below could cost
    // real time — this runs on every scroll — so it is capped rather than
    // trusted to stay small.
    if (chunk.endA - chunk.fromA > MAX_CHAR_DIFF || chunk.endB - chunk.fromB > MAX_CHAR_DIFF)
      continue;
    const aText = (isA ? doc : otherDoc).sliceString(chunk.fromA, chunk.endA);
    const bText = (isA ? otherDoc : doc).sliceString(chunk.fromB, chunk.endB);
    const base = isA ? chunk.fromA : chunk.fromB;
    for (const ch of smartChanges(aText, bText)) {
      const from = base + (isA ? ch.fromA : ch.fromB);
      const to = base + (isA ? ch.toA : ch.toB);
      // one range per line: a range that crosses a newline would be drawn
      // selection-style — out to the pane edge and across blank lines —
      // where these marks should hug the text. A change with nothing on
      // this side (or only a line break) marks nothing at all.
      let pos = from;
      while (pos < to) {
        const line = doc.lineAt(pos);
        const end = Math.min(to, line.to);
        if (pos < end) {
          let marks = byLine.get(line.number);
          if (!marks) byLine.set(line.number, (marks = []));
          marks.push({ from: pos, to: end });
        }
        pos = line.to + 1;
      }
    }
  }

  // A line this thoroughly marked has been rewritten, not edited, and the gaps
  // left bare are only the words that happened to survive — `the`, `per
  // domain`, the `s` on a plural. Marking around them is the disconnected
  // read; filling the line is what VS Code shows, and it is also the truth.
  // Indentation stays out of it: it is structure, not text.
  const ranges: { from: number; to: number }[] = [];
  for (const [num, marks] of byLine) {
    const line = doc.line(num);
    const from = line.from + (line.text.length - line.text.trimStart().length);
    const covered = marks.reduce((sum, m) => sum + (m.to - m.from), 0);
    if (line.to > from && covered >= (line.to - from) * MOSTLY_REWRITTEN) {
      ranges.push({ from, to: line.to });
    } else {
      ranges.push(...marks);
    }
  }
  return ranges;
}

/** Past this many characters on either side, a chunk gets no character marks
 *  — see the cull in [`changedRanges`]. About 600 lines. */
const MAX_CHAR_DIFF = 20000;

/** The character diff inside a chunk is bounded too. Chunks are line-sized
 *  now, so nothing realistic comes near this; it exists so that no input can
 *  make a scroll frame quadratic. */
const CHAR_DIFF = { scanLimit: 500, timeout: 50 };

const WORD = /[A-Za-z0-9_]/;

/** How much of a line has to be marked before the whole line is — see the fill
 *  at the end of [`changedRanges`]. */
const MOSTLY_REWRITTEN = 2 / 3;

interface Change {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}

/**
 * The raw diff with VS Code's word heuristic applied: a change that covers at
 * least two thirds of the word it sits in grows to the whole word. The text a
 * change grows over is common — it sits between changes, so it is the same
 * characters on both sides — which is what lets both ranges extend by the same
 * amounts and stay aligned. `highlight`/`mark` + a common trailing `s` becomes
 * whole words marked on both sides; deleting `use` from `useState` (three
 * chars of an eight-char word) stays exactly `use`. Changes that grow into
 * each other merge.
 */
function smartChanges(a: string, b: string): Change[] {
  const out: Change[] = [];
  // the length of the last change on its own, which is not the length of the
  // run it may have been merged into — comparing against the run would let one
  // merge widen the bar for the next and swallow the whole line a gap at a time
  let prevWidth = 0;
  for (const ch of diff(a, b, CHAR_DIFF)) {
    let { fromA, toA, fromB, toB } = ch;
    let left = 0;
    while (fromA - left > 0 && fromB - left > 0 && WORD.test(a[fromA - left - 1])) left++;
    let right = 0;
    while (toA + right < a.length && toB + right < b.length && WORD.test(a[toA + right])) right++;
    const changed = Math.max(toA - fromA, toB - fromB);
    if (left + right > 0 && changed / (changed + left + right) >= 2 / 3) {
      fromA -= left;
      fromB -= left;
      toA += right;
      toB += right;
    }
    const width = Math.max(toA - fromA, toB - fromB);
    const prev = out[out.length - 1];
    // The text between two changes is common to both sides, so its length is
    // the same on both; take either.
    const gap = prev ? Math.min(fromA - prev.toA, fromB - prev.toB) : Infinity;
    if (prev && gap <= Math.max(prevWidth, width) / 2) {
      prev.toA = Math.max(prev.toA, toA);
      prev.toB = Math.max(prev.toB, toB);
    } else {
      out.push({ fromA, toA, fromB, toB });
    }
    prevWidth = width;
  }
  return out;
}
