import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "../App";
import { Sidebar, SidebarTab } from "./Sidebar";
import type { Reveal } from "./FileTree";
import { EditorPane } from "./EditorPane";
import { TerminalPanes } from "./Terminals";
import { QuickOpen } from "./QuickOpen";
import {
  EDITOR,
  SIDEBAR,
  collectRects,
  isTerm,
  leafIds,
  parentDirOf,
  precedes,
  nodeAt,
  seatedLeaf,
  seatedLeafAtRoot,
  sizesOf,
  useLayoutTree,
  type Divider,
  type LayoutNode,
  type Rect,
  type Side,
} from "../lib/layout";
import { flushSync } from "react-dom";
import { moveItem, movedIndex } from "../lib/tabReorder";
import { onPathMoved, under } from "../lib/fileEvents";
import { projectSession, saveProject } from "../lib/session";
import { useSearch } from "../lib/search";
import { useMemos } from "../lib/memos";

export type View =
  // `staged` picks which of git's two diffs this is: HEAD→index when set, and
  // index→working tree when not. Optional because sessions written before it
  // existed have no such field, and the working-tree diff is what they were.
  // `from` is the path this file had before it was moved, when it was. The
  // staged side of a rename is HEAD, and HEAD has never heard of the new path
  // — asked for it, it answers with nothing and the diff reads as a brand new
  // file rather than as the same one, one folder over.
  | {
      kind: "diff";
      key: string;
      worktree: string;
      relPath: string;
      staged?: boolean;
      from?: string;
    }
  | { kind: "file"; key: string; absPath: string; line?: number }
  | { kind: "new"; key: string; name: string }
  // A memo, opened as the thread it is rather than as the file it also is. No
  // root on it: views belong to the workspace that holds them, and that
  // workspace is the project the memo was recorded in. The files are still
  // reachable — ⌥ on the row opens the raw as a file view, and the breadcrumb
  // over the thread opens the document — which is what keeps this a reading of
  // a memo rather than a second place it lives.
  | { kind: "memo"; key: string; id: string };

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

/* ----- the drag's numbers -----
   Every threshold the gesture answers to, gathered here to be tuned from.
   Distances are CSS px. Direct-sibling swaps stay instant on entry — if that
   ever proves twitchy on small panes, an entry buffer belongs in this list.
   The share clamps a seat may take live with the tree ops, in layout.ts. */
/** travel before a press becomes a carry — a click with a shake in it stays a click */
const DRAG_START = 5;
/** the window-edge band that aims a drop at the root rather than at any pane */
const EDGE_STRIP = 22;
/** a split band's share of the extent it crosses… */
const SPLIT_BAND = 0.25;
/** …never thinner than this, so a short pane still offers one */
const SPLIT_BAND_MIN = 28;
/** …and never wider, so a tall pane doesn't become mostly band */
const SPLIT_BAND_MAX = 90;
/** crosswise travel before split bands arm at all — a level slide never splits */
const CROSS_ARM = 24;

/**
 * Everything in this window that a keystroke might belong to instead of to us.
 *
 * Every other shortcut here carries ⌘ or ⌃ and can be read off the key alone.
 * The recording keys carry nothing — ⎋ and space, because a hand that is
 * talking into a mic is not on a modifier — and a bare space is a letter to
 * every text surface in the app: the commit message, the search fields, the
 * quick-open box, CodeMirror's editor (which is a contenteditable), and the
 * terminal, where it is also a letter to whatever is running in it. So the gate
 * is the target rather than the key: if the event started anywhere you can
 * type, the key was never ours. `contenteditable` is matched by presence
 * rather than by `="true"`, because the attribute has several truthy spellings
 * and only one false one.
 */
const TEXT_SURFACES = 'input, textarea, [contenteditable]:not([contenteditable="false"]), .xterm';

const typing = (e: KeyboardEvent) =>
  e.target instanceof Element && e.target.closest(TEXT_SURFACES) !== null;

// memoised: switching projects changes `active` on exactly two of them, and
// without this every other open project re-renders its whole tree for nothing
export const Workspace = memo(function Workspace({
  project,
  active,
  locked,
}: {
  project: Project;
  active: boolean;
  /** the titlebar's layout lock. On, panes cannot be picked up: the grab
   *  pills never arm and startPaneDrag is inert — only the carrying is
   *  locked, so splits and divider resizes go on working. */
  locked: boolean;
}) {
  // last session's layout for this project. Read once: the component is keyed
  // by root, so a mount is always a project arriving, never one changing.
  const [saved] = useState(() => projectSession(project.root));
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(saved.sidebarTab ?? "scm");
  const [sidebarVisible, setSidebarVisible] = useState(saved.sidebarVisible ?? true);
  const [terminalVisible, setTerminalVisible] = useState(saved.terminalVisible ?? true);
  const [quickOpen, setQuickOpen] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const revealCount = useRef(0);
  const [views, setViews] = useState<View[]>(saved.views ?? []);
  const [activeView, setActiveView] = useState(saved.activeView ?? 0);
  const untitledRef = useRef(0);
  const tree = useLayoutTree(project.root, saved);
  // held here rather than in the panel so a result list survives a look at the
  // file tree — the sidebar renders one tab at a time
  const search = useSearch(project.root);
  // up here for the same reason, plus one of its own: the rail's dot is drawn
  // by a tab you aren't on, about a recording that outlives every panel
  const memos = useMemos(
    project.root,
    active && sidebarVisible && sidebarTab === "memos",
    // a memo recorded here lands in the editor the moment it comes back ready,
    // as the same thread its row opens
    (id) => openView({ kind: "memo", key: `memo:${id}`, id }),
    // a cleanup that failed for want of a login is fixed in a terminal, and
    // the terminals are this component's to open
    () => {
      setTerminalVisible(true);
      tree.newTerminal("claude /login");
    }
  );

  // everything this project should look like next launch. The store debounces,
  // so a divider drag firing this per mousemove costs one write at the end.
  useEffect(() => {
    saveProject(project.root, {
      layout: tree.root,
      focusedId: tree.focusedId,
      sidebarTab,
      sidebarVisible,
      terminalVisible,
      views,
      activeView,
    });
  }, [
    project.root,
    tree.root,
    tree.focusedId,
    sidebarTab,
    sidebarVisible,
    terminalVisible,
    views,
    activeView,
  ]);

  const openView = useCallback((v: View) => {
    setViews((prev) => {
      const idx = prev.findIndex((x) => x.key === v.key);
      if (idx >= 0) {
        // refresh line target for file views (search jumps)
        const next = [...prev];
        next[idx] = v;
        setActiveView(idx);
        return next;
      }
      setActiveView(prev.length);
      return [...prev, v];
    });
  }, []);

  // an untitled buffer turns into a real file view once it's saved somewhere
  const replaceView = useCallback((idx: number, v: View) => {
    setViews((prev) => prev.map((old, i) => (i === idx ? v : old)));
  }, []);

  /**
   * A file a tab is holding open was renamed, or thrown away.
   *
   * Renaming something you have open is an ordinary thing to do, and without
   * this the tab keeps the old path: it goes on showing the file's last
   * contents and fails the next time anything reads it, which is a bug that
   * only surfaces minutes later. So the views follow the file — including the
   * ones under a renamed *folder*, which is why this is a prefix test and not
   * an equality one. Trashed, and the tab goes with it; there is nothing left
   * for it to be a view of.
   *
   * Diffs are addressed by worktree plus relative path, so a rename inside the
   * worktree is the same rewrite with the root put back on afterwards.
   */
  useEffect(
    () =>
      onPathMoved((from, to) => {
        setViews((prev) => {
          let touched = false;
          const next: View[] = [];
          for (const v of prev) {
            if (v.kind === "file" && under(v.absPath, from)) {
              touched = true;
              if (to === null) continue;
              const moved = to + v.absPath.slice(from.length);
              next.push({ ...v, key: `file:${moved}`, absPath: moved });
            } else if (v.kind === "diff" && under(`${v.worktree}/${v.relPath}`, from)) {
              touched = true;
              if (to === null) continue;
              const moved = to + `${v.worktree}/${v.relPath}`.slice(from.length);
              // the same key the changes panel builds, or the tab would keep an
              // identity naming a path it no longer points at — and a second
              // click on that row would open a duplicate of it
              const rel = moved.slice(v.worktree.length + 1);
              const key = v.staged
                ? `diff:staged:${v.worktree}:${rel}`
                : `diff:${v.worktree}:${rel}`;
              next.push({ ...v, key, relPath: rel });
            } else {
              next.push(v);
            }
          }
          if (!touched) return prev;
          setActiveView((cur) => Math.min(cur, Math.max(next.length - 1, 0)));
          return next;
        });
      }),
    []
  );

  // ⌘E's second half, on its own so the right-click menus can reach it: walk
  // the tree open to this file and light its row. The keystroke works out
  // *which* file from the active tab; a menu already knows.
  const revealInTree = useCallback((abs: string) => {
    setSidebarVisible(true);
    setSidebarTab("files");
    setReveal({ path: abs, n: revealCount.current++ });
  }, []);

  // a resolved path from a ⌘-click, in the terminal or in the editor
  const openFile = useCallback(
    (abs: string, line?: number) =>
      openView({ kind: "file", key: `file:${abs}`, absPath: abs, line }),
    [openView]
  );

  const reorderViews = useCallback((from: number, to: number) => {
    setViews((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      setActiveView((cur) => movedIndex(cur, from, to));
      return moveItem(prev, from, to);
    });
  }, []);

  // Closed tabs, newest last, with the slot each one held. Kept in a ref
  // rather than in state: nothing renders from it, and a stack that triggered
  // a re-render on every close would re-render the whole workspace to record
  // something nobody is looking at. Bounded, because it costs a View apiece
  // and the twentieth undo of a close is not a thing anyone reaches for.
  const closedRef = useRef<{ view: View; idx: number }[]>([]);

  const closeView = useCallback((idx: number) => {
    setViews((prev) => {
      const gone = prev[idx];
      if (gone) {
        closedRef.current.push({ view: gone, idx });
        if (closedRef.current.length > 20) closedRef.current.shift();
      }
      const next = prev.filter((_, i) => i !== idx);
      setActiveView((cur) => Math.min(cur > idx ? cur - 1 : cur, Math.max(next.length - 1, 0)));
      return next;
    });
  }, []);

  /**
   * "Close Others" — everything but one, in one go, and all of it reopenable.
   *
   * Pushed onto the same stack in the order they were closed, so ⌘⇧T walks
   * back through them one at a time rather than treating the lot as one event.
   * That's the behaviour the stack already has for a run of ⌘W presses, and a
   * menu item is no different to a fast hand.
   */
  const closeOthers = useCallback((keep: number) => {
    setViews((prev) => {
      if (prev.length < 2) return prev;
      prev.forEach((view, i) => {
        if (i === keep) return;
        closedRef.current.push({ view, idx: i });
        if (closedRef.current.length > 20) closedRef.current.shift();
      });
      setActiveView(0);
      return prev.filter((_, i) => i === keep);
    });
  }, []);

  /**
   * ⌘⇧T — put back the tab you just closed, in the slot it was closed from.
   *
   * The slot rather than the end, because reopening is undoing: a tab that
   * comes back three places to the right of where it was is a second thing to
   * fix. It is clamped to the current length, since the tabs on its right may
   * have gone too.
   *
   * Anything already open is skipped rather than duplicated — reopen a file by
   * hand and its entry in the stack is spent, or ⌘⇧T would hand you the tab
   * you are standing on and look like it did nothing.
   */
  const reopenClosed = useCallback(() => {
    setViews((prev) => {
      let entry = closedRef.current.pop();
      while (entry && prev.some((v) => v.key === entry!.view.key)) {
        entry = closedRef.current.pop();
      }
      if (!entry) return prev;
      const at = Math.min(entry.idx, prev.length);
      const next = [...prev.slice(0, at), entry.view, ...prev.slice(at)];
      setActiveView(at);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey;
      const ctrl = e.ctrlKey;
      // The two keys that only exist while this project holds the mic: ⎋ throws
      // the recording away, space stops and starts the listening. Nothing else
      // in the app answers to either of them unmodified, and they last for the
      // length of a recording — which is the only window in which reaching for
      // a modifier is the wrong thing to ask of someone who is mid-sentence.
      // `preventDefault` matters twice here: it keeps space from scrolling a
      // panel, and it keeps space from pressing whichever of these buttons was
      // clicked last and still has focus, which would otherwise toggle twice.
      const rec = memosRef.current.recording;
      if (rec && !meta && !ctrl && !e.altKey && !typing(e)) {
        if (e.key === "Escape") {
          e.preventDefault();
          memosRef.current.cancel();
          return;
        }
        if (e.code === "Space") {
          e.preventDefault();
          if (rec.paused) memosRef.current.resume();
          else memosRef.current.pause();
          return;
        }
      }
      if (meta && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarVisible((v) => !v);
      } else if ((meta && e.key.toLowerCase() === "j" && !e.shiftKey) || (ctrl && e.code === "Backquote" && !e.shiftKey)) {
        e.preventDefault();
        setTerminalVisible((v) => !v);
      } else if (meta && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        closeView(activeViewRefValue.current);
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "t") {
        // ⌘⇧T, the way Cursor and VS Code spell it — and not ⌘⇧Tab, which
        // never arrives: macOS keeps that one for walking the app switcher
        // backwards and the window is never told it was pressed.
        e.preventDefault();
        reopenClosed();
      } else if (meta && e.key.toLowerCase() === "e") {
        // the tree opens on the file you're looking at, folders and all —
        // ⌘⇧E does it too, since that's the one people arrive with
        e.preventDefault();
        setSidebarVisible(true);
        setSidebarTab("files");
        const v = viewsRef.current[activeViewRefValue.current];
        const abs =
          v?.kind === "file" ? v.absPath : v?.kind === "diff" ? `${v.worktree}/${v.relPath}` : null;
        if (abs) revealInTree(abs);
      } else if (meta && e.shiftKey && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "h")) {
        // ⌘⇧F searches, ⌘⇧H arrives with the replace field already open — the
        // same split VS Code and Cursor make
        e.preventDefault();
        setSidebarVisible(true);
        setSidebarTab("search");
        search.focus(e.key.toLowerCase() === "h");
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setSidebarVisible(true);
        setSidebarTab("scm");
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        setSidebarVisible(true);
        setSidebarTab("memos");
      } else if ((ctrl && e.shiftKey && e.code === "Backquote") || (meta && !e.shiftKey && e.key.toLowerCase() === "t")) {
        e.preventDefault();
        setTerminalVisible(true);
        tree.newTerminal();
      } else if (meta && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        untitledRef.current += 1;
        const n = untitledRef.current;
        openView({ kind: "new", key: `new:${project.root}:${n}`, name: `untitled-${n}` });
      } else if (meta && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setQuickOpen((v) => !v);
        // `code`, not `key`: with shift held the character is `|`, so matching
        // on `e.key === "\\"` skipped the whole branch and split-down never
        // fired. Same reason the terminal toggle above matches Backquote.
      } else if (meta && e.code === "Backslash") {
        e.preventDefault();
        setTerminalVisible(true);
        tree.splitFocused(e.shiftKey ? "col" : "row");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    closeView,
    reopenClosed,
    openView,
    project.root,
    search.focus,
    tree.newTerminal,
    tree.splitFocused,
  ]);

  // keep a ref-like holder for activeView so the key handler doesn't rebind constantly
  const activeViewRefValue = useStateRef(activeView);
  const viewsRef = useStateRef(views);
  // and one for the memos, for a stronger version of the same reason: this
  // object is rebuilt on every tick of the elapsed timer, so a handler that
  // closed over it would be torn down and rebound twice a second for the whole
  // of a recording — during the one gesture that has to stay responsive
  const memosRef = useStateRef(memos);

  // Which memo the list should draw as selected. Derived here rather than in the
  // panel because "selected" means "this is the thread you are reading", and
  // what you are reading is a fact about the editor's tabs — which the workspace
  // owns and the sidebar has never been told about. The alternative was handing
  // the panel the view list so it could work out the same answer, which is a
  // panel that knows what a tab is in order to draw a background.
  const shown = views[activeView];
  const activeMemo = shown?.kind === "memo" ? shown.id : null;

  const rootRef = useRef<HTMLDivElement>(null);

  // ----- carrying a pane -----
  // Same gesture for every pane — a terminal, the editor, the sidebar: pick
  // it up by the pill at its top and carry it. The feedback is the drop's own
  // nature, the way the Claude app does it. Aiming a re-seat — a drop along
  // the axis of the split the target already lives in — slides the other
  // panes into the layout the drop would make, live and animated: the gap
  // that opens is the seat. Aiming a true split — a drop across that axis —
  // draws a single accent line along the edge it would cut, and nothing
  // moves until release. ⎋ puts everything back.

  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** the tree as the drop would leave it, worn live while a re-seat is
   *  aimed — the preview and the drop are the same computation. Every pane's
   *  committed rect stays frozen for the length of the drag; this tree shows
   *  itself as per-pane transforms over them (previewShift below), so a
   *  frame of preview costs the compositor a slide and the layout engine
   *  nothing at all — no reflow, no terminal refit, no repaint of text. */
  const [previewRoot, setPreviewRoot] = useState<LayoutNode | null>(null);
  /** the line a split shows, along the edge of the pane it would cut */
  const [splitHint, setSplitHint] = useState<{ rect: Rect; side: Side } | null>(null);
  /** the pill under the pointer, for the two panes that arm here (terminals
   *  arm their own). Armed by proximity rather than :hover so the pill never
   *  takes the pointer at rest from the tabs and icons it floats over. */
  const [grabArmed, setGrabArmed] = useState<"sidebar" | "editor" | null>(null);
  // locking while a pill happens to be lit must put it out — the mousemove
  // that armed it is gated from then on and would never disarm it
  useEffect(() => {
    if (locked) setGrabArmed(null);
  }, [locked]);

  // ----- the layout, drawn -----
  // One tree, one absolute field. Hidden panes stay leaves — the sidebar
  // toggled away, every terminal while ⌘J holds — and simply get no rect:
  // their siblings renormalise into the room, and everything comes back to
  // its own seat because nothing ever left the tree. The rects always come
  // from the committed tree — a drag freezes them by never committing until
  // the drop — and an aimed re-seat rides on top as transforms.
  const hiddenIds = new Set<string>();
  if (!sidebarVisible) hiddenIds.add(SIDEBAR);
  const termIds = leafIds(tree.root).filter(isTerm);
  if (!terminalVisible) for (const id of termIds) hiddenIds.add(id);

  const panes: { id: string; rect: Rect }[] = [];
  const dividers: Divider[] = [];
  collectRects(tree.root, { x: 0, y: 0, w: 100, h: 100 }, [], hiddenIds, panes, dividers);
  const rectOf = (id: string) => panes.find((p) => p.id === id)?.rect ?? null;
  /** where the aimed drop would put each pane, while one is aimed */
  const previewPanes: { id: string; rect: Rect }[] | null = previewRoot ? [] : null;
  if (previewRoot && previewPanes)
    collectRects(previewRoot, { x: 0, y: 0, w: 100, h: 100 }, [], hiddenIds, previewPanes, []);
  /**
   * The preview, worn as a slide: the distance from a pane's frozen rect to
   * its place in the aimed layout, as a translate in percentages of the
   * pane's own box — so nothing is ever measured back off the DOM. Same-axis
   * re-seats preserve every size, so for them this slide is the exact
   * layout; a seat in a foreign split only approximates until the drop
   * (sizes stay pinned mid-drag, so a target giving ground may overlap its
   * neighbour a little while the gap opens). The carried card is never
   * shifted — it rides the pointer, and its seat is the gap the others leave.
   */
  const previewShift = (id: string): string | undefined => {
    if (!previewPanes || id === draggingId) return undefined;
    const at = rectOf(id);
    const to = previewPanes.find((p) => p.id === id)?.rect;
    if (!at || !to) return undefined;
    const tx = ((to.x - at.x) / at.w) * 100;
    const ty = ((to.y - at.y) / at.h) * 100;
    if (Math.abs(tx) < 0.01 && Math.abs(ty) < 0.01) return undefined;
    return `translate(${tx}%, ${ty}%)`;
  };
  const paneStyle = (rect: Rect | null, shift?: string): React.CSSProperties =>
    rect
      ? {
          left: `${rect.x}%`,
          top: `${rect.y}%`,
          width: `${rect.w}%`,
          height: `${rect.h}%`,
          transform: shift,
        }
      : { display: "none" };
  // stable order, never tree order: re-seating a pane must not reorder the
  // keyed siblings, or React would move live terminal DOM around the tree
  const termPanes = [...termIds]
    .sort()
    .map((id) => ({ id, rect: rectOf(id), shift: previewShift(id) }));

  /**
   * What a drop at this point would do. Targets are measured against the
   * layout as it stood when the card was picked up — never against the
   * preview sliding under the pointer, which would chase its own feedback.
   *
   * Re-seats answer early: hovering a direct sibling swaps across it the
   * moment the pointer arrives (which side of it you came from already says
   * where you're going), and a foreign pane seats by its midline. True
   * splits — drops across the target's own axis — live in narrow bands
   * along the crossing edges, so they are asked for deliberately rather
   * than tripped over. Window-edge strips aim at the root.
   */
  const targetAt = (
    cx: number,
    cy: number,
    dragged: string,
    dRect: Rect,
    base: { id: string; rect: Rect }[],
    travelX: number,
    travelY: number
  ):
    | { op: "pane"; targetId: string; side: Side; seat: boolean; ratio: number; rect: Rect }
    | { op: "root"; side: Side; seat: boolean; extent: number; rect: Rect }
    | null => {
    const root = rootRef.current;
    if (!root) return null;
    const rr = root.getBoundingClientRect();
    const fx = clamp(cx - rr.left, 0, rr.width);
    const fy = clamp(cy - rr.top, 0, rr.height);
    const whole: Rect = { x: 0, y: 0, w: 100, h: 100 };
    const edge = Math.min(fx, rr.width - fx, fy, rr.height - fy);
    if (edge < EDGE_STRIP) {
      const side: Side =
        edge === fx ? "left" : edge === rr.width - fx ? "right" : edge === fy ? "up" : "down";
      const axis = side === "left" || side === "right" ? "row" : "col";
      const seat = tree.root.type === "split" && tree.root.dir === axis;
      const extent = (axis === "row" ? dRect.w : dRect.h) / 100;
      return { op: "root", side, seat, extent, rect: whole };
    }
    const px = (fx / rr.width) * 100;
    const py = (fy / rr.height) * 100;
    const hit = base.find(
      (p) =>
        p.id !== dragged &&
        px >= p.rect.x &&
        px < p.rect.x + p.rect.w &&
        py >= p.rect.y &&
        py < p.rect.y + p.rect.h
    );
    if (!hit) return null;
    const pdir = parentDirOf(tree.root, hit.id);
    // pixel geometry of the hovered pane, for bands and midlines
    const wPx = (hit.rect.w / 100) * rr.width;
    const hPx = (hit.rect.h / 100) * rr.height;
    const inX = fx - (hit.rect.x / 100) * rr.width;
    const inY = fy - (hit.rect.y / 100) * rr.height;
    if (!pdir) {
      // a lone pane: there is nothing to seat beside, every edge is a split
      const m = Math.min(inX, wPx - inX, inY, hPx - inY);
      const side: Side =
        m === inX ? "left" : m === wPx - inX ? "right" : m === inY ? "up" : "down";
      return { op: "pane", targetId: hit.id, side, seat: false, ratio: 0.5, rect: hit.rect };
    }
    // Split bands arm only once the hand has actually travelled across the
    // axis. Every drag starts at a pane's top pill, so a level slide into a
    // neighbour skims its top band the whole way — and a level slide means
    // reorder, not split. Real splits arrive crosswise, and those get the
    // bands at full size.
    const band = (cross: number) =>
      Math.min(Math.max(cross * SPLIT_BAND, SPLIT_BAND_MIN), SPLIT_BAND_MAX);
    if (pdir === "row") {
      const b = Math.abs(travelY) > CROSS_ARM ? band(hPx) : 0;
      if (b > 0 && (inY < b || inY > hPx - b)) {
        const side: Side = inY < b ? "up" : "down";
        return { op: "pane", targetId: hit.id, side, seat: false, ratio: 0.5, rect: hit.rect };
      }
      const pre = precedes(tree.root, dragged, hit.id);
      const side: Side = pre === true ? "right" : pre === false ? "left" : inX < wPx / 2 ? "left" : "right";
      return {
        op: "pane",
        targetId: hit.id,
        side,
        seat: true,
        ratio: dRect.w / (dRect.w + hit.rect.w),
        rect: hit.rect,
      };
    }
    const b = Math.abs(travelX) > CROSS_ARM ? band(wPx) : 0;
    if (b > 0 && (inX < b || inX > wPx - b)) {
      const side: Side = inX < b ? "left" : "right";
      return { op: "pane", targetId: hit.id, side, seat: false, ratio: 0.5, rect: hit.rect };
    }
    const pre = precedes(tree.root, dragged, hit.id);
    const side: Side = pre === true ? "down" : pre === false ? "up" : inY < hPx / 2 ? "up" : "down";
    return {
      op: "pane",
      targetId: hit.id,
      side,
      seat: true,
      ratio: dRect.h / (dRect.h + hit.rect.h),
      rect: hit.rect,
    };
  };

  const startPaneDrag = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0 || locked) return;
    e.preventDefault();
    const root = rootRef.current;
    const card = root?.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
    if (!root || !card) return;
    // the zones and the pin come from the settled layout, before any preview
    const base: { id: string; rect: Rect }[] = [];
    collectRects(tree.root, { x: 0, y: 0, w: 100, h: 100 }, [], hiddenIds, base, []);
    const pin = base.find((p) => p.id === id)?.rect ?? null;
    if (!pin) return;
    const sx = e.clientX;
    const sy = e.clientY;
    // nothing happens until the pointer has clearly left the press — a click
    // with a shake in it must not send a card an inch into the air
    let live = false;
    let target: ReturnType<typeof targetAt> = null;
    let lastKey = "";

    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!live) {
        if (Math.hypot(dx, dy) < DRAG_START) return;
        live = true;
        document.body.classList.add("dragging-panel");
        setDraggingId(id);
      }
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      target = targetAt(ev.clientX, ev.clientY, id, pin, base, dx, dy);
      const key = target
        ? `${target.op}:${target.op === "pane" ? target.targetId : ""}:${target.side}:${target.seat}`
        : "";
      if (key === lastKey) return;
      lastKey = key;
      if (!target) {
        setPreviewRoot(null);
        setSplitHint(null);
      } else if (target.seat) {
        setSplitHint(null);
        setPreviewRoot(
          target.op === "pane"
            ? seatedLeaf(tree.root, id, target.targetId, target.side, target.ratio)
            : seatedLeafAtRoot(tree.root, id, target.side, target.extent)
        );
      } else {
        setPreviewRoot(null);
        setSplitHint({ rect: target.rect, side: target.side });
      }
    };
    const finish = (apply: boolean) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", key, true);
      document.body.classList.remove("dragging-panel");
      const from = live ? card.getBoundingClientRect() : null;
      // every other pane's visual rect too, read before the tree commits:
      // the preview slides are mid-glide, and where a pane is seen is where
      // its landing has to start from
      const others: [HTMLElement, DOMRect][] = from
        ? Array.from(root.querySelectorAll<HTMLElement>("[data-pane-id]"))
            .filter((el) => el !== card)
            .map((el) => [el, el.getBoundingClientRect()])
        : [];
      // one synchronous commit: the tree, the preview and the class all
      // land before the next paint, so there is no frame where the card is
      // half one thing and half the other
      flushSync(() => {
        setDraggingId(null);
        setPreviewRoot(null);
        setSplitHint(null);
        if (apply && live && target) {
          if (target.op === "pane") {
            if (target.seat) tree.seatLeaf(id, target.targetId, target.side, target.ratio);
            else tree.moveLeaf(id, target.targetId, target.side);
          } else if (target.seat) {
            tree.seatLeafAtRoot(id, target.side, target.extent);
          } else {
            tree.moveLeafToRoot(id, target.side);
          }
        }
      });
      // Land everything from exactly where it was seen. The DOM now wears
      // the committed rects — that one commit is the drop's only layout —
      // and each pane replays its visual position over its new seat (FLIP)
      // and releases, so the whole landing is a set of transform glides the
      // layout engine never hears about. The card that settles is the card
      // that was carried — one glide, no swap of a ghost for an original.
      if (from) {
        card.style.transition = "none";
        card.style.transform = "";
        for (const [el] of others) el.style.transition = "none";
        const to = card.getBoundingClientRect();
        const flips: [HTMLElement, number, number][] = [];
        for (const [el, was] of others) {
          const now = el.getBoundingClientRect();
          const dx = was.left - now.left;
          const dy = was.top - now.top;
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) flips.push([el, dx, dy]);
        }
        card.style.transform = `translate(${from.left - to.left}px, ${from.top - to.top}px)`;
        for (const [el, dx, dy] of flips) el.style.transform = `translate(${dx}px, ${dy}px)`;
        const resized = Math.abs(from.width - to.width) > 1 || Math.abs(from.height - to.height) > 1;
        const pw = card.style.width;
        const ph = card.style.height;
        if (resized) {
          // the one landing that is a resize glides between its two sizes
          // as itself; its terminal's refit waits at the far end (the
          // .landing gate in Terminals), so the text holds still and the
          // card clips until it settles
          card.classList.add("landing");
          card.style.width = `${from.width}px`;
          card.style.height = `${from.height}px`;
        }
        void card.offsetWidth;
        card.style.transition = "";
        card.style.transform = "";
        for (const [el] of others) el.style.transition = "";
        for (const [el] of flips) el.style.transform = "";
        if (resized) {
          card.style.width = `${to.width}px`;
          card.style.height = `${to.height}px`;
          // back to the layout's own percentages once the glide is done
          window.setTimeout(() => {
            card.style.width = pw;
            card.style.height = ph;
            card.classList.remove("landing");
          }, 200);
        }
      } else {
        card.style.transform = "";
      }
    };
    const up = () => finish(true);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    window.addEventListener("keydown", key, true);
  };

  /**
   * Drag a seam to change how two visible neighbours share their split.
   * Shares are recomputed from the sizes captured at mousedown, so a long
   * gesture can't accumulate rounding drift. Everything is stored shares of
   * the full split — hidden siblings keep holding theirs — so the pointer's
   * travel across the visible span converts through visSum on the way in.
   */
  const startDividerResize = (e: React.MouseEvent, d: Divider) => {
    const root = rootRef.current;
    const node = nodeAt(tree.root, d.path);
    if (!root || !node || node.type !== "split") return;
    e.preventDefault();
    // only the divider in hand lights
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add("live");
    const base = sizesOf(node);
    const rr = root.getBoundingClientRect();
    const span = d.dir === "row" ? (rr.width * d.host.w) / 100 : (rr.height * d.host.h) / 100;
    if (span <= 0) return;
    // neither side may be squeezed below a usable pane
    const min = Math.min(0.15, 60 / span) * d.visSum;
    const start = d.dir === "row" ? e.clientX : e.clientY;

    const move = (ev: MouseEvent) => {
      const travelled = (d.dir === "row" ? ev.clientX : ev.clientY) - start;
      const delta = (travelled / span) * d.visSum;
      const room = { back: base[d.li] - min, fwd: base[d.ri] - min };
      const step = Math.max(-room.back, Math.min(room.fwd, delta));
      const sizes = [...base];
      sizes[d.li] = base[d.li] + step;
      sizes[d.ri] = base[d.ri] - step;
      tree.setSizes(d.path, sizes);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      handle.classList.remove("live");
      document.body.classList.remove("dragging-col", "dragging-row");
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    document.body.classList.add(d.dir === "row" ? "dragging-col" : "dragging-row");
  };

  /** the arming mousemove for a wrapper whose pill lives here — the
   *  sidebar's and the editor's; `reach` ducks under whatever chrome the
   *  card keeps at its top (the editor's tabs sit lower than the sidebar's
   *  icon strip) */
  const armWrapper = (kind: "sidebar" | "editor", reach: number) => (e: React.MouseEvent) => {
    if (draggingId || locked) return;
    const r = e.currentTarget.getBoundingClientRect();
    const grab = e.clientY - r.top < reach && Math.abs(e.clientX - (r.left + r.width / 2)) < 32;
    setGrabArmed((cur) => (grab ? kind : cur === kind ? null : cur));
  };
  const disarmWrapper = (kind: "sidebar" | "editor") => () =>
    setGrabArmed((cur) => (cur === kind ? null : cur));

  return (
    <div ref={rootRef} className={`workspace ${active ? "" : "inactive"}`}>
      {sidebarVisible && (
        <div
          className={`pane-abs ${draggingId === SIDEBAR ? "moving" : ""}`}
          data-pane-id={SIDEBAR}
          style={paneStyle(rectOf(SIDEBAR), previewShift(SIDEBAR))}
          onMouseMove={armWrapper("sidebar", 14)}
          onMouseLeave={disarmWrapper("sidebar")}
        >
          <div
            className={`pane-grab ${grabArmed === "sidebar" ? "armed" : ""} ${
              draggingId === SIDEBAR ? "live" : ""
            }`}
            title="move sidebar"
            onMouseDown={(e) => startPaneDrag(e, SIDEBAR)}
          />
          <Sidebar
            project={project}
            tab={sidebarTab}
            onTab={setSidebarTab}
            onOpenView={openView}
            active={active}
            search={search}
            memos={memos}
            activeMemo={activeMemo}
            activeKey={shown?.key ?? null}
            reveal={reveal}
            onRevealInTree={revealInTree}
          />
        </div>
      )}
      <div
        className={`pane-abs main-col ${draggingId === EDITOR ? "moving" : ""}`}
        data-pane-id={EDITOR}
        style={paneStyle(rectOf(EDITOR), previewShift(EDITOR))}
        onMouseMove={armWrapper("editor", 12)}
        onMouseLeave={disarmWrapper("editor")}
      >
        <div
          className={`pane-grab ${grabArmed === "editor" ? "armed" : ""} ${
            draggingId === EDITOR ? "live" : ""
          }`}
          title="move editor"
          onMouseDown={(e) => startPaneDrag(e, EDITOR)}
        />
        <EditorPane
          views={views}
          activeView={activeView}
          onSelect={setActiveView}
          onClose={closeView}
          onCloseOthers={closeOthers}
          onReplace={replaceView}
          onReorder={reorderViews}
          onOpenFile={openFile}
          onRevealInTree={revealInTree}
          root={project.root}
          // a memo tab draws its own live title and records its own
          // follow-ups, both of which are this object
          memos={memos}
        />
      </div>
      <TerminalPanes
        tree={tree}
        panes={termPanes}
        active={active}
        locked={locked}
        draggingId={draggingId}
        onPaneDragStart={startPaneDrag}
        onOpenFile={openFile}
      />
      {/* one divider per visible seam of the tree */}
      {dividers.map((d) => (
        <div
          key={`${d.path.join(".")}:${d.li}`}
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
          onMouseDown={(e) => startDividerResize(e, d)}
        />
      ))}
      {/* the line a true split shows, along the edge it would cut — re-seats
          need no mark: the layout itself rearranges live under the hand */}
      {splitHint && <div className={`split-hint ${splitHint.side}`} style={paneStyle(splitHint.rect)} />}
      {quickOpen && (
        <QuickOpen
          root={project.root}
          onClose={() => setQuickOpen(false)}
          onPick={(rel) => {
            setQuickOpen(false);
            openView({ kind: "file", key: `file:${project.root}/${rel}`, absPath: `${project.root}/${rel}` });
          }}
        />
      )}
    </div>
  );
});

function useStateRef<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
