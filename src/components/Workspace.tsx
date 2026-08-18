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
  nodeAt,
  sizesOf,
  useLayoutTree,
  type Divider,
  type Rect,
  type Side,
} from "../lib/layout";
import { moveItem, movedIndex } from "../lib/tabReorder";
import { onPathMoved, under } from "../lib/fileEvents";
import { projectSession, saveProject } from "../lib/session";
import { useSearch } from "../lib/search";
import { useMemos } from "../lib/memos";

export type View =
  // `staged` picks which of git's two diffs this is: HEAD→index when set, and
  // index→working tree when not. Optional because sessions written before it
  // existed have no such field, and the working-tree diff is what they were.
  | { kind: "diff"; key: string; worktree: string; relPath: string; staged?: boolean }
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
}: {
  project: Project;
  active: boolean;
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

  // ----- the layout, drawn -----
  // One tree, one absolute field. Hidden panes stay leaves — the sidebar
  // toggled away, every terminal while ⌘J holds — and simply get no rect:
  // their siblings renormalise into the room, and everything comes back to
  // its own seat because nothing ever left the tree.
  const hiddenIds = new Set<string>();
  if (!sidebarVisible) hiddenIds.add(SIDEBAR);
  const termIds = leafIds(tree.root).filter(isTerm);
  if (!terminalVisible) for (const id of termIds) hiddenIds.add(id);

  const panes: { id: string; rect: Rect }[] = [];
  const dividers: Divider[] = [];
  collectRects(tree.root, { x: 0, y: 0, w: 100, h: 100 }, [], hiddenIds, panes, dividers);
  const rectOf = (id: string) => panes.find((p) => p.id === id)?.rect ?? null;
  const paneStyle = (rect: Rect | null): React.CSSProperties =>
    rect
      ? { left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%`, height: `${rect.h}%` }
      : { display: "none" };
  // stable order, never tree order: re-seating a pane must not reorder the
  // keyed siblings, or React would move live terminal DOM around the tree
  const termPanes = [...termIds].sort().map((id) => ({ id, rect: rectOf(id) }));

  // ----- carrying a pane -----
  // Same gesture for every pane — a terminal, the editor, the sidebar: pick
  // it up by the pill at its top, carry it, and a shaded rectangle shows the
  // exact room the drop would give it; release to take the seat, ⎋ to put it
  // back. The carried card only translates — the layout doesn't reflow until
  // the drop, so a live terminal is never disturbed mid-air.

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Rect | null>(null);
  /** the pill under the pointer, for the two panes that arm here (terminals
   *  arm their own). Armed by proximity rather than :hover so the pill never
   *  takes the pointer at rest from the tabs and icons it floats over. */
  const [grabArmed, setGrabArmed] = useState<"sidebar" | "editor" | null>(null);

  /**
   * What a drop at this point would do, and the rect it would produce — the
   * one function both the shaded preview and the drop itself consume, which
   * is what keeps them the same fact. A strip along any window edge inserts
   * against the whole root and takes a third of the window; anywhere else,
   * the outer bands of the pane under the pointer split that pane in half.
   */
  const dropTargetAt = (
    cx: number,
    cy: number,
    dragged: string
  ):
    | { kind: "pane"; id: string; side: Side; rect: Rect }
    | { kind: "root"; side: Side; rect: Rect }
    | null => {
    const root = rootRef.current;
    if (!root) return null;
    const rr = root.getBoundingClientRect();
    const fx = clamp(cx - rr.left, 0, rr.width);
    const fy = clamp(cy - rr.top, 0, rr.height);
    const edge = Math.min(fx, rr.width - fx, fy, rr.height - fy);
    if (edge < 22) {
      const side: Side =
        edge === fx ? "left" : edge === rr.width - fx ? "right" : edge === fy ? "up" : "down";
      const t = 100 / 3;
      const rect: Rect =
        side === "left"
          ? { x: 0, y: 0, w: t, h: 100 }
          : side === "right"
            ? { x: 100 - t, y: 0, w: t, h: 100 }
            : side === "up"
              ? { x: 0, y: 0, w: 100, h: t }
              : { x: 0, y: 100 - t, w: 100, h: t };
      return { kind: "root", side, rect };
    }
    const px = (fx / rr.width) * 100;
    const py = (fy / rr.height) * 100;
    const hit = panes.find(
      (p) =>
        p.id !== dragged &&
        px >= p.rect.x &&
        px < p.rect.x + p.rect.w &&
        py >= p.rect.y &&
        py < p.rect.y + p.rect.h
    );
    if (!hit) return null;
    // which edge of the pane under the pointer is nearest, in its own axes
    const rx = (px - hit.rect.x) / hit.rect.w;
    const ry = (py - hit.rect.y) / hit.rect.h;
    const m = Math.min(rx, 1 - rx, ry, 1 - ry);
    const side: Side = m === rx ? "left" : m === 1 - rx ? "right" : m === ry ? "up" : "down";
    const { x, y, w, h } = hit.rect;
    const rect: Rect =
      side === "left"
        ? { x, y, w: w / 2, h }
        : side === "right"
          ? { x: x + w / 2, y, w: w / 2, h }
          : side === "up"
            ? { x, y, w, h: h / 2 }
            : { x, y: y + h / 2, w, h: h / 2 };
    return { kind: "pane", id: hit.id, side, rect };
  };

  const startPaneDrag = (e: React.MouseEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const root = rootRef.current;
    const card = root?.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
    if (!root || !card) return;
    const sx = e.clientX;
    const sy = e.clientY;
    // nothing happens until the pointer has clearly left the press — a click
    // with a shake in it must not send a card an inch into the air
    let live = false;
    let target: ReturnType<typeof dropTargetAt> = null;

    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!live) {
        if (Math.hypot(dx, dy) < 5) return;
        live = true;
        document.body.classList.add("dragging-panel");
        setDraggingId(id);
      }
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      target = dropTargetAt(ev.clientX, ev.clientY, id);
      const rect = target?.rect ?? null;
      setPreview((cur) =>
        cur === rect ||
        (cur && rect && cur.x === rect.x && cur.y === rect.y && cur.w === rect.w && cur.h === rect.h)
          ? cur
          : rect
      );
    };
    const finish = (apply: boolean) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", key, true);
      document.body.classList.remove("dragging-panel");
      card.style.transform = "";
      setDraggingId(null);
      setPreview(null);
      if (apply && live && target) {
        if (target.kind === "pane") tree.moveLeaf(id, target.id, target.side);
        else tree.moveLeafToRoot(id, target.side);
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
    if (draggingId) return;
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
          style={paneStyle(rectOf(SIDEBAR))}
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
        style={paneStyle(rectOf(EDITOR))}
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
      {/* the room a drop would take, drawn by the same numbers the drop uses */}
      {preview && (
        <div
          className="drop-preview"
          style={{
            left: `${preview.x}%`,
            top: `${preview.y}%`,
            width: `${preview.w}%`,
            height: `${preview.h}%`,
          }}
        />
      )}
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
