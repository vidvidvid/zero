import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../lib/api";
import { ptyBus } from "../lib/ptyBus";
import { attachSmoothScroll } from "../lib/smoothTermScroll";
import { pathLinkProvider } from "../lib/termLinks";

/** A clicked link leaves the app entirely — the Rust side vets the scheme */
function openLink(uri: string) {
  api.openUrl(uri).catch((e) => console.warn(`link: ${e}`));
}

export type TermNode =
  | { type: "leaf"; id: string }
  /** `sizes` are each child's share of the split, summing to 1 */
  | { type: "split"; dir: "row" | "col"; children: TermNode[]; sizes?: number[] };

function newLeaf(): TermNode {
  return { type: "leaf", id: crypto.randomUUID() };
}

// a split with no sizes yet is an even one
function sizesOf(node: Extract<TermNode, { type: "split" }>): number[] {
  const n = node.children.length;
  if (node.sizes && node.sizes.length === n) return node.sizes;
  return Array.from({ length: n }, () => 1 / n);
}

/** the split node a divider belongs to, addressed by child indices from the root */
function nodeAt(node: TermNode | null, path: number[]): TermNode | null {
  let cur: TermNode | null = node;
  for (const i of path) {
    if (!cur || cur.type !== "split") return null;
    cur = cur.children[i] ?? null;
  }
  return cur;
}

function withSizes(node: TermNode, path: number[], sizes: number[]): TermNode {
  if (node.type !== "split") return node;
  if (path.length === 0) return { ...node, sizes };
  const [head, ...rest] = path;
  return {
    ...node,
    children: node.children.map((c, i) => (i === head ? withSizes(c, rest, sizes) : c)),
  };
}

export type Side = "left" | "right" | "up" | "down";

function insertAt(node: TermNode, targetId: string, side: Side, leaf: TermNode): TermNode {
  const dir: "row" | "col" = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "up";
  if (node.type === "leaf") {
    if (node.id !== targetId) return node;
    return { type: "split", dir, children: before ? [leaf, node] : [node, leaf], sizes: [0.5, 0.5] };
  }
  // if a direct child is the target and directions match, insert as sibling
  const idx = node.children.findIndex((c) => c.type === "leaf" && c.id === targetId);
  if (idx >= 0 && node.dir === dir) {
    const children = [...node.children];
    children.splice(before ? idx : idx + 1, 0, leaf);
    // the newcomer halves the target's share; every other pane keeps its own
    const sizes = [...sizesOf(node)];
    const half = sizes[idx] / 2;
    sizes[idx] = half;
    sizes.splice(before ? idx : idx + 1, 0, half);
    return { ...node, children, sizes };
  }
  return { ...node, children: node.children.map((c) => insertAt(c, targetId, side, leaf)) };
}

function removeLeaf(node: TermNode, id: string): TermNode | null {
  if (node.type === "leaf") return node.id === id ? null : node;
  const sizes = sizesOf(node);
  const children: TermNode[] = [];
  const kept: number[] = [];
  node.children.forEach((c, i) => {
    const next = removeLeaf(c, id);
    if (next === null) return;
    children.push(next);
    kept.push(sizes[i]);
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  // the closed pane's share is handed to the survivors in proportion
  const total = kept.reduce((a, b) => a + b, 0);
  return { ...node, children, sizes: kept.map((s) => s / total) };
}

function firstLeafId(node: TermNode): string {
  return node.type === "leaf" ? node.id : firstLeafId(node.children[0]);
}

function hasLeaf(node: TermNode, id: string): boolean {
  return node.type === "leaf" ? node.id === id : node.children.some((c) => hasLeaf(c, id));
}

export interface TerminalTree {
  root: TermNode | null;
  cwd: string;
  focusedId: string | null;
  setFocused: (id: string) => void;
  newTerminal: () => void;
  splitFocused: (dir: "row" | "col") => void;
  splitPane: (id: string, side: Side) => void;
  removePane: (id: string) => void;
  setSizes: (path: number[], sizes: number[]) => void;
}

/**
 * `restore` is last session's layout, if there was one. Only read on the first
 * render — the tree is this hook's from then on.
 */
export function useTerminalTree(
  cwd: string,
  restore?: { root?: TermNode | null; focusedId?: string | null }
): TerminalTree {
  const [root, setRoot] = useState<TermNode | null>(() => restore?.root ?? newLeaf());
  const [focusedId, setFocused] = useState<string | null>(() => {
    if (!root) return null;
    const saved = restore?.focusedId;
    return saved && hasLeaf(root, saved) ? saved : firstLeafId(root);
  });

  const newTerminal = useCallback(() => {
    const leaf = newLeaf();
    setRoot((r) => {
      if (!r) return leaf;
      if (r.type === "split" && r.dir === "row") {
        // the newcomer takes an equal share, the rest shrink proportionally
        const share = 1 / (r.children.length + 1);
        const sizes = [...sizesOf(r).map((s) => s * (1 - share)), share];
        return { ...r, children: [...r.children, leaf], sizes };
      }
      return { type: "split", dir: "row", children: [r, leaf], sizes: [0.5, 0.5] };
    });
    setFocused((leaf as { id?: string }).id ?? null);
  }, []);

  const setSizes = useCallback((path: number[], sizes: number[]) => {
    setRoot((r) => (r ? withSizes(r, path, sizes) : r));
  }, []);

  const splitPane = useCallback((id: string, side: Side) => {
    const leaf = newLeaf();
    setRoot((r) => {
      if (!r) return leaf;
      return insertAt(r, id, side, leaf);
    });
    setFocused((leaf as { id?: string }).id ?? null);
  }, []);

  const splitFocused = useCallback(
    (dir: "row" | "col") => {
      if (!focusedId) return;
      splitPane(focusedId, dir === "row" ? "right" : "down");
    },
    [focusedId, splitPane]
  );

  const removePane = useCallback((id: string) => {
    setRoot((r) => {
      const next = r ? removeLeaf(r, id) : null;
      setFocused((f) => (f === id ? (next ? firstLeafId(next) : null) : f));
      return next;
    });
  }, []);

  return {
    root,
    cwd,
    focusedId,
    setFocused,
    newTerminal,
    splitFocused,
    splitPane,
    removePane,
    setSizes,
  };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** the draggable line between two children of one split */
interface Divider {
  path: number[];
  index: number;
  dir: "row" | "col";
  /** where the line sits, as a fraction along the split */
  at: number;
  /** the split's own rect — the length the drag is measured against */
  host: Rect;
}

// Flatten the split tree into absolute percentage rects. Panes render as
// keyed siblings of one container, so tree restructuring never re-parents
// (and therefore never remounts / kills) a live terminal.
function collectRects(
  node: TermNode,
  rect: Rect,
  path: number[],
  out: { id: string; rect: Rect }[],
  dividers: Divider[]
) {
  if (node.type === "leaf") {
    out.push({ id: node.id, rect });
    return;
  }
  const sizes = sizesOf(node);
  let at = 0;
  node.children.forEach((c, i) => {
    const f = sizes[i];
    const r =
      node.dir === "row"
        ? { x: rect.x + rect.w * at, y: rect.y, w: rect.w * f, h: rect.h }
        : { x: rect.x, y: rect.y + rect.h * at, w: rect.w, h: rect.h * f };
    collectRects(c, r, [...path, i], out, dividers);
    at += f;
    if (i < node.children.length - 1) {
      dividers.push({ path, index: i, dir: node.dir, at, host: rect });
    }
  });
}

export function Terminals({
  tree,
  visible,
  height,
  active,
  onOpenFile,
}: {
  tree: TerminalTree;
  visible: boolean;
  height: number;
  active: boolean;
  /** a ⌘-clicked path that belongs to this project */
  onOpenFile: (abs: string, line?: number) => void;
}) {
  // The pane toolbar only exists near the top edge of a pane, so working in
  // the middle of a session never puts chrome on screen.
  const [armed, setArmed] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Drag a divider to change how two neighbouring panes share their split.
  // Shares are recomputed from the sizes captured at mousedown, so a long
  // gesture can't accumulate rounding drift.
  const startResize = useCallback(
    (e: React.MouseEvent, d: Divider) => {
      const body = bodyRef.current;
      const node = nodeAt(tree.root, d.path);
      if (!body || !node || node.type !== "split") return;
      e.preventDefault();
      const base = sizesOf(node);
      const br = body.getBoundingClientRect();
      const span = d.dir === "row" ? (br.width * d.host.w) / 100 : (br.height * d.host.h) / 100;
      if (span <= 0) return;
      // neither side may be squeezed below a usable pane
      const min = Math.min(0.15, 60 / span);
      const start = d.dir === "row" ? e.clientX : e.clientY;

      const move = (ev: MouseEvent) => {
        const travelled = (d.dir === "row" ? ev.clientX : ev.clientY) - start;
        const room = { back: base[d.index] - min, fwd: base[d.index + 1] - min };
        const delta = Math.max(-room.back, Math.min(room.fwd, travelled / span));
        const sizes = [...base];
        sizes[d.index] = base[d.index] + delta;
        sizes[d.index + 1] = base[d.index + 1] - delta;
        tree.setSizes(d.path, sizes);
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.classList.remove("dragging-col", "dragging-row");
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
      document.body.classList.add(d.dir === "row" ? "dragging-col" : "dragging-row");
    },
    [tree]
  );

  const panes: { id: string; rect: Rect }[] = [];
  const dividers: Divider[] = [];
  if (tree.root) collectRects(tree.root, { x: 0, y: 0, w: 100, h: 100 }, [], panes, dividers);

  return (
    <div className="term-panel" style={{ display: visible ? "flex" : "none", height }}>
      <div className="term-body" ref={bodyRef}>
        {tree.root ? (
          (() => {
            return panes.map(({ id, rect }) => (
              <div
                key={id}
                className="term-abs"
                style={{
                  left: `${rect.x}%`,
                  top: `${rect.y}%`,
                  width: `${rect.w}%`,
                  height: `${rect.h}%`,
                  borderLeft: rect.x > 0 ? "1px solid var(--border)" : "none",
                  borderTop: rect.y > 0 ? "1px solid var(--border)" : "none",
                }}
                onMouseMove={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  // the top fifth, floored so a short pane still has a strip
                  // you can actually aim at
                  const zone = Math.max(r.height * 0.2, 28);
                  const near = e.clientY - r.top < zone;
                  setArmed((cur) => (near ? id : cur === id ? null : cur));
                }}
                onMouseLeave={() => setArmed((cur) => (cur === id ? null : cur))}
              >
                <div className={`pane-actions ${armed === id ? "visible" : ""}`}>
                  <button title="add terminal left" onClick={() => tree.splitPane(id, "left")}>
                    ◧
                  </button>
                  <button title="add terminal above" onClick={() => tree.splitPane(id, "up")}>
                    ⬒
                  </button>
                  <button title="add terminal below" onClick={() => tree.splitPane(id, "down")}>
                    ⬓
                  </button>
                  <button title="add terminal right" onClick={() => tree.splitPane(id, "right")}>
                    ◨
                  </button>
                  <button className="pane-close" title="close terminal" onClick={() => tree.removePane(id)}>
                    ✕
                  </button>
                </div>
                <TerminalPane
                  id={id}
                  cwd={tree.cwd}
                  focused={tree.focusedId === id}
                  active={active && visible}
                  onFocus={tree.setFocused}
                  onExit={tree.removePane}
                  onOpenFile={onOpenFile}
                />
              </div>
            ));
          })()
        ) : (
          <div className="term-empty">
            <kbd>⌘T</kbd> for a terminal
          </div>
        )}
        {/* invisible grab strips straddling each split line */}
        {dividers.map((d) => (
          <div
            key={`${d.path.join(".")}:${d.index}`}
            className={`term-divider ${d.dir}`}
            style={
              d.dir === "row"
                ? {
                    left: `${d.host.x + d.host.w * d.at}%`,
                    top: `${d.host.y}%`,
                    height: `${d.host.h}%`,
                  }
                : {
                    top: `${d.host.y + d.host.h * d.at}%`,
                    left: `${d.host.x}%`,
                    width: `${d.host.w}%`,
                  }
            }
            onMouseDown={(e) => startResize(e, d)}
          />
        ))}
      </div>
    </div>
  );
}

/** breathing room around a terminal, before the sub-row remainder is added */

// Dark Modern (VS Code / Cursor) — panel bg + default terminal ANSI palette
const TERM_THEME = {
  background: "#181818",
  foreground: "#cccccc",
  cursor: "#cccccc",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

function TerminalPane({
  id,
  cwd,
  focused,
  active,
  onFocus,
  onExit,
  onOpenFile,
}: {
  id: string;
  cwd: string;
  focused: boolean;
  active: boolean;
  onFocus: (id: string) => void;
  onExit: (id: string) => void;
  onOpenFile: (abs: string, line?: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // the link provider is registered once, for the life of the pane, but the
  // callback it closes over is a fresh function every render
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const term = new Terminal({
      theme: TERM_THEME,
      fontFamily: '"SF Mono", "Menlo", "Monaco", monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      // wheel scrolling is ours now (see attachSmoothScroll) so sensitivity
      // lives there; 0 duration still matters — it keeps the scrollLines calls
      // we make immediate rather than easing towards the target
      smoothScrollDuration: 0,
      // OSC 8 hyperlinks — the escape sequence that carries a URI behind text
      // that reads as something else ("PR #9422"). xterm parses them either
      // way; without a handler they're simply inert, which is why clicking one
      // did nothing.
      linkHandler: {
        activate: (_e, uri) => openLink(uri),
      },
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    // bare URLs and file paths in ordinary output. OSC 8 links are separate —
    // the terminal parses those itself and calls linkHandler above.
    const links = term.registerLinkProvider(
      pathLinkProvider(term, cwd, (abs, line) => onOpenFileRef.current(abs, line))
    );

    // DOM renderer on purpose. WebGL: WKWebView drops the contexts (frozen
    // panes, webview crashes). Canvas: the only build that exists is compiled
    // against xterm 5 internals and renders nothing on xterm 6 — tried it,
    // terminal came up blank. CSS-painted cells it is. Note the renderer has
    // nothing to do with scroll smoothness; that's handled below.
    fit.fit();

    // A terminal holds a whole number of rows, so a pane almost never divides
    // evenly and something has to absorb the remainder. Putting it in the
    // padding — above the first row, below the last, or split between them —
    // moves the text as the pane resizes, because the remainder sweeps a whole
    // row while you drag. Every version of that was visible and annoying.
    //
    // So the remainder goes above the first row and the block hangs from the
    // bottom edge instead. Every row then keeps a fixed offset from the bottom,
    // which is the whole trick: the gap at the top grows as you drag and not
    // one line of text moves, at any granularity. When the gap reaches a full
    // row the count ticks up and a new row appears in it.
    //
    // `floor`, not `ceil`. `ceil` leaves no gap at all and gives flat padding
    // on every side, but it pays for that by slicing the top row where the clip
    // cuts it — and a half-visible first line is worse than an uneven gap, as
    // anyone who has lost the top of a "Restored session" line will tell you.
    // So the sides stay a flat 6px and the top runs to a row more than that.
    const applySize = () => {
      const clip = el.parentElement;
      // one row element, never the whole block divided by term.rows: rows
      // update synchronously but the renderer repaints on the next frame, so
      // mid-resize that division yields a cell height far too short
      const row = el.querySelector<HTMLElement>(".xterm-rows > div");
      const cell = row?.getBoundingClientRect().height ?? 0;
      const dims = fit.proposeDimensions();
      // before the first paint there is no row to measure; fit() does the same
      // arithmetic against the host, and the rAF below redoes this properly
      if (!clip || !dims || !(cell > 1)) {
        fit.fit();
        return;
      }
      // measured against the clip, never the host: the host's own height is
      // what this adjusts, and reading it back would oscillate
      const room = clip.clientHeight;
      const rows = Math.max(1, Math.floor(room / cell));
      if (term.cols !== dims.cols || term.rows !== rows) term.resize(dims.cols, rows);
      el.style.top = `${room - rows * cell}px`;
    };
    applySize();
    // once more after the first paint, for the case where the renderer hasn't
    // put any rows in the DOM yet at this point
    const sizeRaf = window.requestAnimationFrame(applySize);

    const smooth = attachSmoothScroll(term, { host: el });

    // subscribe before spawning: the shell's first prompt can land before an
    // awaited spawn resolves, and there is no replay
    const decoder = { current: null as null | TextDecoder };
    ptyBus.onOutput(id, (bytes) => term.write(bytes));
    ptyBus.onExit(id, () => onExit(id));

    api.ptySpawn(id, cwd, term.cols || 80, term.rows || 24).catch((e) => {
      term.write(`\r\n\x1b[31mzero: failed to start shell: ${e}\x1b[0m\r\n`);
    });
    term.onData((data) =>
      api.ptyWrite(id, data).catch((e) => {
        term.write(`\r\n\x1b[31mzero: shell unreachable: ${e}\x1b[0m\r\n`);
      })
    );

    // macOS editing keys, Cursor-style: ⌥⌫ word-delete, ⌘⌫ kill line,
    // ⌥←/→ word-jump, ⌘←/→ line start/end — translated to readline codes
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const send = (s: string) => {
        api.ptyWrite(id, s).catch(() => {});
        return false;
      };
      if (ev.metaKey && !ev.altKey && !ev.ctrlKey) {
        if (ev.key === "Backspace") return send("\x15");
        if (ev.key === "ArrowLeft") return send("\x01");
        if (ev.key === "ArrowRight") return send("\x05");
      }
      if (ev.altKey && !ev.metaKey && !ev.ctrlKey) {
        if (ev.key === "Backspace") return send("\x1b\x7f");
        if (ev.key === "ArrowLeft") return send("\x1bb");
        if (ev.key === "ArrowRight") return send("\x1bf");
      }
      return true;
    });
    void decoder;

    // fit visually every frame during drags (debouncing leaves the exposed
    // strip showing the cleared canvas = black flash); only the pty notify
    // is debounced
    let resizeTimer = 0;
    let resizeRaf = 0;
    const observer = new ResizeObserver(() => {
      if (resizeRaf) return;
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = 0;
        if (el.clientWidth === 0 || el.clientHeight === 0) return;
        smooth.reset();
        applySize();
        if (term.rows > 0) term.refresh(0, term.rows - 1);
        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          if (term.cols > 0 && term.rows > 0) {
            api.ptyResize(id, term.cols, term.rows).catch(() => {});
          }
        }, 50);
      });
    });
    // watch the clip, not the host: applySize() resizes the host, and observing
    // what you resize is a feedback loop
    observer.observe(el.parentElement ?? el);

    const onFocusIn = () => onFocus(id);
    el.addEventListener("focusin", onFocusIn);
    term.focus();

    return () => {
      el.removeEventListener("focusin", onFocusIn);
      observer.disconnect();
      window.clearTimeout(resizeTimer);
      window.cancelAnimationFrame(resizeRaf);
      window.cancelAnimationFrame(sizeRaf);
      smooth.dispose();
      links.dispose();
      ptyBus.off(id);
      api.ptyKill(id).catch(() => {});
      termRef.current = null;
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, cwd]);

  // switching projects no longer unmounts anything, so the outgoing project's
  // terminal would keep the caret and swallow keystrokes — hand it over
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (focused && active) term.focus();
    else if (!active) term.blur();
  }, [focused, active]);

  // three levels on purpose: the pane holds the padding, the clip bounds the
  // sub-row transform, and the host is what xterm opens on
  return (
    <div className={`term-pane ${focused ? "focused" : ""}`}>
      <div className="term-clip">
        <div ref={hostRef} className="term-scroll" />
      </div>
    </div>
  );
}
