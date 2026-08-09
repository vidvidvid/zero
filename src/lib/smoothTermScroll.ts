import type { Terminal } from "@xterm/xterm";

/**
 * Sub-row smooth scrolling for xterm.
 *
 * xterm's Viewport rounds its scroll position to whole rows before asking the
 * renderer to redraw (`Math.round(scrollTop / cellHeight)`), so wheel
 * scrolling advances in ~15px steps no matter which renderer is installed —
 * DOM, canvas or WebGL. Swapping renderers cannot fix it; the quantisation
 * happens above them.
 *
 * So we take the wheel over. Whole rows still go to xterm via the public
 * `scrollLines`, and the leftover fraction becomes a GPU transform on the
 * screen element. Between row boundaries the terminal glides as a composited
 * layer; on a boundary xterm redraws and the offset rolls over by one row.
 *
 * Two things make this work:
 *
 * - We transform `.xterm-screen`, not `.xterm-rows`. xterm derives cell
 *   coordinates from `screenElement.getBoundingClientRect()`, which includes
 *   CSS transforms — so selection, links and mouse reporting follow the offset
 *   automatically instead of drifting by up to a row.
 *
 * - We shift the screen *down*, never up, so the bottom row holding the prompt
 *   stays pinned. Hence `ceil` rather than xterm's `round`. Mid-gesture this
 *   exposes up to one row of panel background along the top edge; at rest the
 *   offset is zero and the edge is flush.
 *
 * An earlier version rendered one extra row and hid it above the clip, to fill
 * that sliver. That row is only spare when the buffer has scrolled — on a fresh
 * shell the prompt sits on row 0, so the terminal clipped away the very thing
 * you needed to see, and the pane looked dead while working perfectly.
 */

/** How far the content moves per pixel of finger travel. 1 = web-page mapping. */
const SENSITIVITY = 2;

interface Options {
  /** Element the terminal was opened on. */
  host: HTMLElement;
}

export interface SmoothScroll {
  reset: () => void;
  dispose: () => void;
}

export function attachSmoothScroll(term: Terminal, { host }: Options): SmoothScroll {
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return { reset: () => {}, dispose: () => {} };

  // px the screen is currently shifted down, always within [0, cellHeight)
  let resid = 0;
  let cellH = 0;

  // Always a transform, never "" — clearing it drops the composited layer, and
  // the next gesture then stalls ~150ms rasterising a full-screen text surface
  // before it can move. Measured: one such stall at the start of every scroll.
  const apply = () => {
    screen.style.transform = `translate3d(0, ${resid}px, 0)`;
  };

  const measure = (): number => {
    const rows = host.querySelector<HTMLElement>(".xterm-rows");
    if (!rows || term.rows < 1) return 0;
    const h = rows.getBoundingClientRect().height / term.rows;
    return h > 1 ? h : 0;
  };

  const reset = () => {
    if (resid === 0) return;
    resid = 0;
    apply();
  };


  // xterm's viewport would otherwise consume the wheel itself and round the
  // position away before we ever see it
  const scrollable = (
    term as unknown as {
      _core?: { _viewport?: { _scrollableElement?: { updateOptions?: (o: object) => void } } };
    }
  )._core?._viewport?._scrollableElement;
  scrollable?.updateOptions?.({ handleMouseWheel: false });

  term.attachCustomWheelEventHandler((ev) => {
    // The alt buffer has no scrollback — xterm turns the wheel into arrow keys
    // there so pagers and TUIs still respond. Leave that path alone.
    if (term.buffer.active.type === "alternate") {
      reset();
      return true;
    }
    if (!cellH) {
      cellH = measure();
      if (!cellH) return true;
    }

    let d = ev.deltaY;
    if (ev.deltaMode === 1) d *= cellH;
    else if (ev.deltaMode === 2) d *= cellH * term.rows;
    d *= SENSITIVITY;
    if (!d) return false;

    // split the travel into whole rows for xterm and a remainder for the GPU
    let next = resid - d;
    let lines = 0;
    if (next < 0) {
      lines = Math.ceil(-next / cellH);
      next += lines * cellH;
    } else if (next >= cellH) {
      lines = -Math.floor(next / cellH);
      next += lines * cellH;
    }
    const before = term.buffer.active.viewportY;
    if (lines) term.scrollLines(lines);
    const buf = term.buffer.active;

    // at either end of the buffer there is no row left to absorb a remainder,
    // and holding one would push the prompt off the bottom edge
    if (d > 0 && buf.viewportY >= buf.baseY) next = 0;
    else if (d < 0 && buf.viewportY <= 0) next = 0;

    resid = next;

    // If xterm actually scrolled, its redraw is queued for this frame's
    // animation callback. Moving the screen *now* would shift it by a row
    // before the rows themselves move — a one-frame bounce of exactly one
    // row height, on every boundary crossing. That is what stops this from
    // reading as continuous. Let onRender land both in the same frame.
    if (buf.viewportY === before) apply();
    return false;
  });

  const subs = [
    term.onRender(apply),
    // typing snaps xterm back to the bottom; the offset has to go with it
    term.onData(reset),
    term.onWriteParsed(() => {
      if (resid === 0) return;
      const buf = term.buffer.active;
      if (buf.viewportY >= buf.baseY) reset();
    }),
  ];

  return {
    /** Row count changed — a held offset now describes the wrong geometry. */
    reset: () => {
      cellH = 0;
      reset();
    },
    dispose: () => {
      for (const s of subs) s.dispose();
      reset();
    },
  };
}
