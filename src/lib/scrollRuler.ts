import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { getChunks } from "@codemirror/merge";

/**
 * The lane down the right edge of an editor that maps the whole file: the
 * gutter tells you about the screen, this tells you about the document. Click
 * or drag anywhere in it and the editor scrolls there — the affordance Cursor
 * and VS Code both put in this strip, and the reason it's worth having is that
 * a change you can *see* in the ruler is otherwise still a scroll hunt away.
 *
 * The lane sits just left of the scrollbar rather than over it, so dragging
 * the thumb still works and the two do different jobs: the thumb moves you by
 * where you are, this moves you by what's in the file.
 */

export type TickKind = "add" | "mod" | "del";

/** A run of changed lines, in the ruler's own fraction-of-the-document terms. */
export interface Tick {
  kind: TickKind;
  top: number;
  bottom: number;
}

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/**
 * @param ticks   what to paint, recomputed whenever the layout or document moves
 * @param dirty   extra reasons to repaint, for tick sources that live in a
 *                state field the view doesn't otherwise notice changing
 */
export function scrollRuler(
  ticks: (view: EditorView) => Tick[],
  dirty?: (u: ViewUpdate) => boolean
): Extension {
  return ViewPlugin.fromClass(
    class {
      dom: HTMLElement;
      dragging = false;

      constructor(readonly view: EditorView) {
        this.dom = document.createElement("div");
        this.dom.className = "cm-changeRuler";
        // outside the scroller on purpose: it maps the whole document, so it
        // must not move when the document does
        view.dom.appendChild(this.dom);
        this.dom.addEventListener("pointerdown", this.onDown);
        this.dom.addEventListener("pointermove", this.onMove);
        this.dom.addEventListener("pointerup", this.onUp);
        this.dom.addEventListener("pointercancel", this.onUp);
        this.draw();
      }

      update(u: ViewUpdate) {
        if (u.docChanged || u.geometryChanged || dirty?.(u)) this.draw();
      }

      draw() {
        const next = document.createDocumentFragment();
        for (const t of ticks(this.view)) {
          const el = document.createElement("div");
          el.className = `cm-changeTick cm-change-${t.kind}`;
          el.style.top = `${t.top * 100}%`;
          el.style.height = `${(t.bottom - t.top) * 100}%`;
          next.appendChild(el);
        }
        this.dom.replaceChildren(next);
      }

      /** put the point of the file this Y maps to in the middle of the screen */
      scrollTo(clientY: number) {
        const rect = this.dom.getBoundingClientRect();
        if (!rect.height) return;
        const scroller = this.view.scrollDOM;
        const span = scroller.scrollHeight - scroller.clientHeight;
        if (span <= 0) return;
        const f = clamp((clientY - rect.top) / rect.height, 0, 1);
        scroller.scrollTop = clamp(f * scroller.scrollHeight - scroller.clientHeight / 2, 0, span);
      }

      onDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        // the ruler is over the editor: a press here must not also put the
        // caret somewhere or start a selection
        e.preventDefault();
        this.dragging = true;
        this.dom.setPointerCapture(e.pointerId);
        this.scrollTo(e.clientY);
      };

      onMove = (e: PointerEvent) => {
        if (this.dragging) this.scrollTo(e.clientY);
      };

      onUp = (e: PointerEvent) => {
        this.dragging = false;
        if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
      };

      destroy() {
        this.dom.remove();
      }
    }
  );
}

/**
 * The ruler for a side-by-side diff, drawn from the merge view's own chunks.
 *
 * The file view measures against HEAD itself (see changeGutter.ts); here the
 * other pane *is* the baseline, so there's nothing to compute — the chunks the
 * merge view already tints the lines with are the ticks.
 */
export function diffRuler(): Extension {
  return scrollRuler(chunkTicks, (u) => getChunks(u.state)?.chunks !== getChunks(u.startState)?.chunks);
}

function chunkTicks(view: EditorView): Tick[] {
  const info = getChunks(view.state);
  const total = view.contentHeight;
  if (!info || !total) return [];
  const len = view.state.doc.length;
  const out: Tick[] = [];
  for (const chunk of info.chunks) {
    const own = info.side === "a"
      ? { from: chunk.fromA, to: chunk.toA, end: chunk.endA, otherEmpty: chunk.fromB >= chunk.toB }
      : { from: chunk.fromB, to: chunk.toB, end: chunk.endB, otherEmpty: chunk.fromA >= chunk.toA };
    // nothing on this side: lines were removed and none put back, so the mark
    // goes on the seam they closed over rather than down a line that isn't there
    const kind: TickKind = own.from >= own.to ? "del" : own.otherEmpty ? "add" : "mod";
    const start = view.lineBlockAt(Math.min(own.from, len));
    const last = view.lineBlockAt(Math.min(Math.max(own.end, own.from), len));
    out.push({
      kind,
      top: start.top / total,
      bottom: (last.top + last.height) / total,
    });
  }
  return out;
}
