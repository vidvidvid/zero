import { useCallback, useRef, useState } from "react";
import type React from "react";

/** live state of a tab drag: where it started, where it would land, how far */
export interface TabDrag {
  from: number;
  to: number;
  dx: number;
  /** width of the tab being dragged — what the gap it leaves behind is worth */
  w: number;
}

// far enough that a click that wobbles a pixel still reads as a click
const DRAG_SLOP = 4;

// once a slot is claimed it takes this much travel back to give it up again,
// so a hand resting on the threshold doesn't flip the order back and forth
const HYSTERESIS = 5;

/**
 * Drag-to-reorder for a horizontal tab strip.
 *
 * Geometry is measured once, at mousedown: nothing moves in the DOM until the
 * drop, tabs are only translated, so the measurements stay valid for the whole
 * gesture and the strip can't reflow under the pointer.
 *
 * `selector` matches the tab elements inside the strip the ref is put on.
 */
export function useTabReorder(selector: string, onReorder: (from: number, to: number) => void) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<TabDrag | null>(null);

  const start = useCallback(
    (e: React.MouseEvent, index: number) => {
      const strip = stripRef.current;
      if (!strip || e.button !== 0) return;
      // stops the gesture turning into a text selection or a native drag
      e.preventDefault();
      const rects = [...strip.querySelectorAll<HTMLElement>(selector)].map((el) =>
        el.getBoundingClientRect()
      );
      if (rects.length < 2 || !rects[index]) return;
      const self = rects[index];
      const startX = e.clientX;
      // the tab can't be dragged out of the strip
      const minDx = rects[0].left - self.left;
      const maxDx = rects[rects.length - 1].right - self.right;
      let live: TabDrag | null = null;

      const move = (ev: MouseEvent) => {
        const raw = ev.clientX - startX;
        if (!live && Math.abs(raw) < DRAG_SLOP) return;
        const dx = Math.max(minDx, Math.min(maxDx, raw));
        // Walk outwards while our *leading edge* is past the neighbour's
        // midpoint. Comparing centres instead would make a tab wider than its
        // neighbour unswappable: the clamp only lets it travel the
        // neighbour's width, which isn't far enough to get the centres past
        // each other. Leading edge always is.
        let to = index;
        if (dx < 0) {
          for (let j = index - 1; j >= 0; j--) {
            const claimed = live !== null && j >= live.to;
            const edge = rects[j].left + rects[j].width / 2 + (claimed ? HYSTERESIS : -HYSTERESIS);
            if (self.left + dx >= edge) break;
            to = j;
          }
        } else {
          for (let j = index + 1; j < rects.length; j++) {
            const claimed = live !== null && j <= live.to;
            const edge = rects[j].left + rects[j].width / 2 - (claimed ? HYSTERESIS : -HYSTERESIS);
            if (self.right + dx <= edge) break;
            to = j;
          }
        }
        if (!live) document.body.classList.add("dragging-tab");
        live = { from: index, to, dx, w: self.width };
        setDrag(live);
      };

      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.classList.remove("dragging-tab");
        setDrag(null);
        // both this and the reorder land in one commit, so the tab never
        // flashes at its old position on the way to its new one
        if (live && live.to !== index) onReorder(index, live.to);
      };

      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [onReorder, selector]
  );

  /**
   * Where each tab sits mid-gesture: the dragged one follows the pointer, the
   * ones it has passed slide over by exactly the gap it left.
   */
  const shift = useCallback(
    (i: number): string | undefined => {
      if (!drag) return undefined;
      if (i === drag.from) return `translateX(${drag.dx}px)`;
      if (drag.from < drag.to && i > drag.from && i <= drag.to) return `translateX(${-drag.w}px)`;
      if (drag.to < drag.from && i >= drag.to && i < drag.from) return `translateX(${drag.w}px)`;
      return undefined;
    },
    [drag]
  );

  return { stripRef, drag, start, shift };
}

/**
 * Move `from` to `to` in an array. Shared by every strip, since reordering a
 * list of tabs also means the selected *index* has to travel with the move.
 */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** where a selected index ends up after a tab moves from → to */
export function movedIndex(cur: number, from: number, to: number): number {
  if (cur === from) return to;
  if (from < cur && cur <= to) return cur - 1;
  if (to <= cur && cur < from) return cur + 1;
  return cur;
}
