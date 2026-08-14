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
  const ranges: { from: number; to: number }[] = [];

  for (const chunk of info.chunks) {
    // pure insertions and deletions keep their flat line wash
    if (chunk.fromA >= chunk.toA || chunk.fromB >= chunk.toB) continue;
    // geometry is only measurable (and only needed) inside the viewport
    if ((isA ? chunk.fromA : chunk.fromB) > vTo || (isA ? chunk.endA : chunk.endB) < vFrom)
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
        if (pos < end) ranges.push({ from: pos, to: end });
        pos = line.to + 1;
      }
    }
  }
  return ranges;
}

const WORD = /[A-Za-z0-9_]/;

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
  for (const ch of diff(a, b)) {
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
    const prev = out[out.length - 1];
    if (prev && (fromA <= prev.toA || fromB <= prev.toB)) {
      prev.toA = Math.max(prev.toA, toA);
      prev.toB = Math.max(prev.toB, toB);
    } else {
      out.push({ fromA, toA, fromB, toB });
    }
  }
  return out;
}
