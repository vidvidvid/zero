import { useCallback, useRef, useState } from "react";

/**
 * The workspace's one layout: a split tree whose leaves are every pane in the
 * window — the sidebar, the editor, and each terminal, all equal citizens.
 *
 * This began life as the terminal region's private tree and was promoted
 * whole: the same insertAt that ⌘\ uses to split a terminal is what docks the
 * sidebar against the editor's left edge, and the same removeLeaf that closes
 * a pane is half of every move. There are no groups, no dock modes and no
 * per-edge rules ("terminals at the bottom are full width" is gone) — a pane
 * is wherever the tree says it is, and anything that needs "the terminals"
 * asks about leaf identity, not about a container.
 *
 * Hiding is not removal: ⌘B and ⌘J leave the tree untouched and the layout
 * pass skips the hidden leaves, renormalising their siblings — so a pane
 * brought back lands exactly where it left. That is also why every path into
 * the tree stays valid whatever is hidden: there is only ever one tree.
 */

export type LayoutNode =
  | { type: "leaf"; id: string }
  /** `sizes` are each child's share of the split, summing to 1 */
  | { type: "split"; dir: "row" | "col"; children: LayoutNode[]; sizes?: number[] };

export type Side = "left" | "right" | "up" | "down";

/** the two leaves that aren't terminals. Terminal ids are uuids, so the names
 *  can never collide with one. */
export const SIDEBAR = "sidebar";
export const EDITOR = "editor";

export const isTerm = (id: string) => id !== SIDEBAR && id !== EDITOR;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** the draggable seam between two visible children of one split */
export interface Divider {
  path: number[];
  /** the full-tree child indices either side of the seam — not necessarily
   *  adjacent, since hidden children may lie between them */
  li: number;
  ri: number;
  dir: "row" | "col";
  /** where the seam sits, as a fraction along the split */
  at: number;
  /** the split's own rect — the length a drag is measured against */
  host: Rect;
  /** the stored shares of the split's visible children summed — what a
   *  fraction of the visible span converts through to reach stored sizes */
  visSum: number;
}

// a split with no sizes yet is an even one
export function sizesOf(node: Extract<LayoutNode, { type: "split" }>): number[] {
  const n = node.children.length;
  if (node.sizes && node.sizes.length === n) return node.sizes;
  return Array.from({ length: n }, () => 1 / n);
}

/** the node a path addresses, by child indices from the root */
export function nodeAt(node: LayoutNode | null, path: number[]): LayoutNode | null {
  let cur: LayoutNode | null = node;
  for (const i of path) {
    if (!cur || cur.type !== "split") return null;
    cur = cur.children[i] ?? null;
  }
  return cur;
}

export function withSizes(node: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (node.type !== "split") return node;
  if (path.length === 0) return { ...node, sizes };
  const [head, ...rest] = path;
  return {
    ...node,
    children: node.children.map((c, i) => (i === head ? withSizes(c, rest, sizes) : c)),
  };
}

export function insertAt(node: LayoutNode, targetId: string, side: Side, leaf: LayoutNode): LayoutNode {
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

/**
 * Insert against the whole window's edge rather than any one pane — the drop
 * a window-edge strip offers. The newcomer takes a third rather than half:
 * half of a window is a wall, a third is a dock.
 */
export function insertAtRoot(
  root: LayoutNode | null,
  side: Side,
  leaf: LayoutNode,
  share = 1 / 3
): LayoutNode {
  if (!root) return leaf;
  const dir: "row" | "col" = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "up";
  // a root already split this way takes the newcomer as one more sibling,
  // rather than wrapping itself a level deeper on every drop
  if (root.type === "split" && root.dir === dir) {
    const sizes = sizesOf(root).map((s) => s * (1 - share));
    const children = [...root.children];
    if (before) {
      children.unshift(leaf);
      sizes.unshift(share);
    } else {
      children.push(leaf);
      sizes.push(share);
    }
    return { ...root, children, sizes };
  }
  return {
    type: "split",
    dir,
    children: before ? [leaf, root] : [root, leaf],
    sizes: before ? [share, 1 - share] : [1 - share, share],
  };
}

export function removeLeaf(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === "leaf") return node.id === id ? null : node;
  const sizes = sizesOf(node);
  const children: LayoutNode[] = [];
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

export function hasLeaf(node: LayoutNode | null, id: string): boolean {
  if (!node) return false;
  return node.type === "leaf" ? node.id === id : node.children.some((c) => hasLeaf(c, id));
}

export function leafIds(node: LayoutNode | null, out: string[] = []): string[] {
  if (!node) return out;
  if (node.type === "leaf") out.push(node.id);
  else node.children.forEach((c) => leafIds(c, out));
  return out;
}

export function firstTermId(node: LayoutNode | null): string | null {
  return leafIds(node).find(isTerm) ?? null;
}

/** every leaf of the subtree is hidden — the whole branch takes no room */
function subtreeHidden(node: LayoutNode, hidden: ReadonlySet<string>): boolean {
  return node.type === "leaf"
    ? hidden.has(node.id)
    : node.children.every((c) => subtreeHidden(c, hidden));
}

/**
 * Flatten the tree into absolute percentage rects, skipping hidden leaves —
 * their siblings renormalise into the room, and nothing is emitted for them,
 * so a hidden pane simply has no rect. Dividers come out between *visible*
 * neighbours, carrying the full-tree indices a resize must write back to.
 * Panes render as keyed siblings of one container, so tree restructuring
 * never re-parents (and therefore never remounts / kills) a live pane.
 */
export function collectRects(
  node: LayoutNode,
  rect: Rect,
  path: number[],
  hidden: ReadonlySet<string>,
  out: { id: string; rect: Rect }[],
  dividers: Divider[]
) {
  if (node.type === "leaf") {
    if (!hidden.has(node.id)) out.push({ id: node.id, rect });
    return;
  }
  const stored = sizesOf(node);
  const vis = node.children.map((c) => !subtreeHidden(c, hidden));
  const visSum = stored.reduce((a, s, i) => (vis[i] ? a + s : a), 0);
  if (visSum <= 0) return;
  let at = 0;
  let prevVisible = -1;
  node.children.forEach((c, i) => {
    if (!vis[i]) return;
    const f = stored[i] / visSum;
    const r =
      node.dir === "row"
        ? { x: rect.x + rect.w * at, y: rect.y, w: rect.w * f, h: rect.h }
        : { x: rect.x, y: rect.y + rect.h * at, w: rect.w, h: rect.h * f };
    if (prevVisible >= 0) {
      dividers.push({ path, li: prevVisible, ri: i, dir: node.dir, at, host: rect, visSum });
    }
    collectRects(c, r, [...path, i], hidden, out, dividers);
    at += f;
    prevVisible = i;
  });
}

/* ---------- boot commands ----------
   Commands to type into a terminal the moment its shell is up, keyed by the
   leaf created to run them. Module state rather than tree state so a restored
   layout can never replay one: only `newTerminal(boot)` writes here, and the
   pane consumes its entry on first spawn. */
const boots = new Map<string, string>();

export function takeBoot(id: string): string | undefined {
  const boot = boots.get(id);
  boots.delete(id);
  return boot;
}

/* ---------- the hook ---------- */

export interface LayoutTree {
  root: LayoutNode;
  cwd: string;
  focusedId: string | null;
  setFocused: (id: string) => void;
  /** `boot`, when given, is a command typed into the new shell once it's up */
  newTerminal: (boot?: string) => void;
  splitFocused: (dir: "row" | "col") => void;
  splitPane: (id: string, side: Side) => void;
  removePane: (id: string) => void;
  /** re-seat any pane against another — out of the tree, back in on `side` */
  moveLeaf: (id: string, targetId: string, side: Side) => void;
  /** dock any pane against the whole window's edge */
  moveLeafToRoot: (id: string, side: Side) => void;
  setSizes: (path: number[], sizes: number[]) => void;
}

const freshLeaf = (): LayoutNode => ({ type: "leaf", id: crypto.randomUUID() });

/**
 * A usable tree from whatever was stored. A saved layout is taken as long as
 * it still holds the editor; anything older — the era when the terminal tree
 * and the row order were separate facts — is synthesised into the shape it
 * described, using the retired localStorage keys one last time. The classic
 * arrangement (sidebar and editor side by side, terminals along the floor)
 * survives here as the default for a fresh project, no longer as a rule.
 */
function migrated(saved?: { layout?: LayoutNode | null; term?: LayoutNode | null }): LayoutNode {
  if (saved?.layout && hasLeaf(saved.layout, EDITOR)) {
    // a corrupt tree without a sidebar still opens; the leaf is re-seated
    return hasLeaf(saved.layout, SIDEBAR)
      ? saved.layout
      : insertAtRoot(saved.layout, "left", { type: "leaf", id: SIDEBAR }, 0.2);
  }

  const px = (key: string, fallback: number) => {
    const v = parseFloat(localStorage.getItem(key) ?? "");
    return Number.isFinite(v) ? v : fallback;
  };
  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

  const legacy = localStorage.getItem("zero-row-order")?.split(",");
  const order =
    legacy?.length === 3 && ["sidebar", "editor", "term"].every((k) => legacy.includes(k))
      ? legacy
      : ["sidebar", "editor", "term"];
  const dock = localStorage.getItem("zero-term-dock");
  const bottom = dock !== "left" && dock !== "right" && dock !== "row";
  const terms: LayoutNode = saved?.term ?? freshLeaf();

  const w = Math.max(window.innerWidth, 600);
  const kids: LayoutNode[] = [];
  const sizes: number[] = [];
  for (const m of order) {
    if (m === "sidebar") {
      kids.push({ type: "leaf", id: SIDEBAR });
      sizes.push(clamp((px("zero-sidebar-w", 260) + 8) / w, 0.12, 0.4));
    } else if (m === "editor") {
      kids.push({ type: "leaf", id: EDITOR });
      sizes.push(0); // takes the remainder below
    } else if (!bottom) {
      kids.push(terms);
      sizes.push(clamp((px("zero-term-w", 420) + 8) / w, 0.15, 0.5));
    }
  }
  const editorIdx = kids.findIndex((k) => k.type === "leaf" && k.id === EDITOR);
  sizes[editorIdx] = Math.max(1 - sizes.reduce((a, b) => a + b, 0), 0.2);
  const total = sizes.reduce((a, b) => a + b, 0);
  const row: LayoutNode = {
    type: "split",
    dir: "row",
    children: kids,
    sizes: sizes.map((s) => s / total),
  };
  if (!bottom) return row;

  const h = Math.max(window.innerHeight, 400);
  const tShare = clamp((px("zero-term-h", 300) + 8) / h, 0.15, 0.6);
  return { type: "split", dir: "col", children: [row, terms], sizes: [1 - tShare, tShare] };
}

/**
 * `saved` is last session's layout, if there was one. Only read on the first
 * render — the tree is this hook's from then on.
 */
export function useLayoutTree(
  cwd: string,
  saved?: { layout?: LayoutNode | null; term?: LayoutNode | null; focusedId?: string | null }
): LayoutTree {
  const [root, setRoot] = useState<LayoutNode>(() => migrated(saved));
  const [focusedId, setFocused] = useState<string | null>(() => {
    const want = saved?.focusedId;
    return want && hasLeaf(root, want) && isTerm(want) ? want : firstTermId(root);
  });
  // the keyboard's newTerminal closes over no state through this
  const focusedRef = useRef(focusedId);
  focusedRef.current = focusedId;

  const newTerminal = useCallback((boot?: string) => {
    const id = crypto.randomUUID();
    if (boot) boots.set(id, boot);
    setRoot((r) => {
      const anchorId =
        focusedRef.current && hasLeaf(r, focusedRef.current) && isTerm(focusedRef.current)
          ? focusedRef.current
          : firstTermId(r);
      if (anchorId) return insertAt(r, anchorId, "right", { type: "leaf", id });
      // no terminal anywhere: the classic seat, a strip along the floor
      return insertAtRoot(r, "down", { type: "leaf", id });
    });
    setFocused(id);
  }, []);

  const setSizes = useCallback((path: number[], sizes: number[]) => {
    setRoot((r) => withSizes(r, path, sizes));
  }, []);

  const splitPane = useCallback((id: string, side: Side) => {
    const leaf = freshLeaf();
    setRoot((r) => insertAt(r, id, side, leaf));
    setFocused((leaf as { id: string }).id);
  }, []);

  const splitFocused = useCallback(
    (dir: "row" | "col") => {
      if (!focusedId) return;
      splitPane(focusedId, dir === "row" ? "right" : "down");
    },
    [focusedId, splitPane]
  );

  const removePane = useCallback((id: string) => {
    if (!isTerm(id)) return;
    setRoot((r) => {
      const next = removeLeaf(r, id);
      if (!next) return r; // can't happen: the editor leaf always survives
      setFocused((f) => (f === id ? firstTermId(next) : f));
      return next;
    });
  }, []);

  const moveLeaf = useCallback((id: string, targetId: string, side: Side) => {
    if (id === targetId) return;
    setRoot((r) => {
      if (!hasLeaf(r, id)) return r;
      const without = removeLeaf(r, id);
      if (!without || !hasLeaf(without, targetId)) return r;
      return insertAt(without, targetId, side, { type: "leaf", id });
    });
  }, []);

  const moveLeafToRoot = useCallback((id: string, side: Side) => {
    setRoot((r) => {
      const without = removeLeaf(r, id);
      if (!without) return r; // the only pane is already everywhere
      return insertAtRoot(without, side, { type: "leaf", id });
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
    moveLeaf,
    moveLeafToRoot,
    setSizes,
  };
}
