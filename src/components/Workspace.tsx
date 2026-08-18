import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "../App";
import { Sidebar, SidebarTab } from "./Sidebar";
import type { Reveal } from "./FileTree";
import { EditorPane } from "./EditorPane";
import { Terminals, useTerminalTree } from "./Terminals";
import { QuickOpen } from "./QuickOpen";
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

/** which edge a movable panel hangs on. The sidebar takes a side; the
 *  terminal takes any of the three, and at the bottom it spans the window. */
export type PanelSide = "left" | "right";
export type TermDock = PanelSide | "bottom";

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

function persisted(key: string, fallback: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? "");
  return Number.isFinite(v) ? v : fallback;
}

/** a pane's vertical padding — the part of the panel's height that isn't rows */
const PANE_PAD_Y = 12;

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

function startDrag(
  e: React.MouseEvent,
  axis: "x" | "y",
  dir: 1 | -1,
  start: number,
  min: number,
  max: number,
  set: (v: number) => void,
  /** row height, if this edge should move a whole line at a time */
  step = 0
) {
  e.preventDefault();
  const startPos = axis === "x" ? e.clientX : e.clientY;
  // the handle in hand carries its own highlight: with more than one divider
  // on screen, the body class alone would light every one of them
  const handle = e.currentTarget as HTMLElement;
  handle.classList.add("live");
  document.body.classList.add(axis === "x" ? "dragging-col" : "dragging-row");
  const move = (ev: MouseEvent) => {
    const delta = (axis === "x" ? ev.clientX : ev.clientY) - startPos;
    let next = start + dir * delta;
    // snap to heights that hold a whole number of rows. Measured from the
    // padding, not from zero, or the landing points sit a few px off the rows
    // they're meant to line up with.
    if (step > 1) next = Math.round((next - PANE_PAD_Y) / step) * step + PANE_PAD_Y;
    set(clamp(next, min, max));
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    handle.classList.remove("live");
    document.body.classList.remove("dragging-col", "dragging-row");
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

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
  const [sidebarWidth, setSidebarWidth] = useState(() => persisted("zero-sidebar-w", 260));
  const [quickOpen, setQuickOpen] = useState(false);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const revealCount = useRef(0);
  const [termHeight, setTermHeight] = useState(() => persisted("zero-term-h", 300));
  // Where the movable panels hang. Stored beside the widths rather than in the
  // per-project session because they are the same kind of fact: which side
  // your sidebar lives on is a preference of the hand, not of the project —
  // like the widths, read once per workspace mount.
  const [sidebarSide, setSidebarSide] = useState<PanelSide>(() =>
    localStorage.getItem("zero-sidebar-side") === "right" ? "right" : "left"
  );
  const [termDock, setTermDock] = useState<TermDock>(() => {
    const v = localStorage.getItem("zero-term-dock");
    return v === "left" || v === "right" ? v : "bottom";
  });
  const [termWidth, setTermWidth] = useState(() => persisted("zero-term-w", 420));
  const [views, setViews] = useState<View[]>(saved.views ?? []);
  const [activeView, setActiveView] = useState(saved.activeView ?? 0);
  const untitledRef = useRef(0);
  const term = useTerminalTree(project.root, saved);
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
      term.newTerminal("claude /login");
    }
  );

  useEffect(() => {
    localStorage.setItem("zero-sidebar-w", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem("zero-term-h", String(termHeight));
  }, [termHeight]);
  useEffect(() => {
    localStorage.setItem("zero-term-w", String(termWidth));
  }, [termWidth]);
  useEffect(() => {
    localStorage.setItem("zero-sidebar-side", sidebarSide);
  }, [sidebarSide]);
  useEffect(() => {
    localStorage.setItem("zero-term-dock", termDock);
  }, [termDock]);

  // everything this project should look like next launch. The store debounces,
  // so a divider drag firing this per mousemove costs one write at the end.
  useEffect(() => {
    saveProject(project.root, {
      term: term.root,
      focusedId: term.focusedId,
      sidebarTab,
      sidebarVisible,
      terminalVisible,
      views,
      activeView,
    });
  }, [
    project.root,
    term.root,
    term.focusedId,
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
        term.newTerminal();
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
        term.splitFocused(e.shiftKey ? "col" : "row");
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
    term.newTerminal,
    term.splitFocused,
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

  // this project's own row height. Scoped to the workspace rather than the
  // document because every project's panes are mounted at once, and an
  // inactive one's rows are laid out just as measurably as the visible one's.
  const rootRef = useRef<HTMLDivElement>(null);
  const termCell = () => {
    const row = rootRef.current?.querySelector<HTMLElement>(".xterm-rows > div");
    const h = row?.getBoundingClientRect().height ?? 0;
    return h > 1 ? h : 0;
  };

  // ----- moving a panel -----
  // The gesture: pick a card up by the pill at its top, carry it, and an
  // accent line stands at the edge it would dock to; release to dock it,
  // ⎋ to put it back. The card itself only translates — the layout doesn't
  // reflow until the drop — so a live terminal is never disturbed mid-air.

  /** which panel is in hand, for the pill's own highlight */
  const [movingPanel, setMovingPanel] = useState<"sidebar" | "terminal" | null>(null);
  /** the edge the drop would dock to, or null while nothing is being carried */
  const [dockHint, setDockHint] = useState<TermDock | null>(null);
  /** the pill under the pointer. Armed by proximity rather than by :hover
   *  because the pill must not take the pointer at rest: an always-hittable
   *  strip at the terminal's top centre would be a dead zone in the middle of
   *  a line of text. Armed, it takes clicks; disarmed, clicks fall through. */
  const [grabArmed, setGrabArmed] = useState<"sidebar" | "terminal" | null>(null);

  const armGrabs = (e: React.MouseEvent) => {
    if (movingPanel) return;
    const root = rootRef.current;
    if (!root) return;
    let next: "sidebar" | "terminal" | null = null;
    for (const kind of ["sidebar", "terminal"] as const) {
      if (kind === "sidebar" ? !sidebarVisible : !terminalVisible) continue;
      const el = root.querySelector<HTMLElement>(kind === "sidebar" ? ".sidebar" : ".term-panel");
      if (!el) continue;
      const r = el.getBoundingClientRect();
      // the pill's reach: the top 10px of the card, 32px either side of its
      // centre — under the sidebar's tab icons and beside the terminal's
      // pane actions, so neither loses a click to it
      if (
        e.clientY >= r.top &&
        e.clientY < r.top + 10 &&
        Math.abs(e.clientX - (r.left + r.width / 2)) < 32
      ) {
        next = kind;
        break;
      }
    }
    setGrabArmed((cur) => (cur === next ? cur : next));
  };

  const startPanelMove = useCallback((e: React.MouseEvent, panel: "sidebar" | "terminal") => {
    if (e.button !== 0) return;
    e.preventDefault();
    const root = rootRef.current;
    const card = root?.querySelector<HTMLElement>(panel === "sidebar" ? ".sidebar" : ".term-panel");
    if (!root || !card) return;
    const sx = e.clientX;
    const sy = e.clientY;
    // nothing happens until the pointer has clearly left the press — a click
    // with a shake in it must not send a card an inch into the air
    let live = false;
    let at: TermDock | null = null;

    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!live) {
        if (Math.hypot(dx, dy) < 5) return;
        live = true;
        document.body.classList.add("dragging-panel");
        card.classList.add("moving");
        setMovingPanel(panel);
      }
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      const r = root.getBoundingClientRect();
      let next: TermDock;
      if (panel === "sidebar") {
        next = ev.clientX < r.left + r.width / 2 ? "left" : "right";
      } else {
        const dl = ev.clientX - r.left;
        const dr = r.right - ev.clientX;
        const db = r.bottom - ev.clientY;
        next = db <= dl && db <= dr ? "bottom" : dl < dr ? "left" : "right";
      }
      if (next !== at) {
        at = next;
        setDockHint(next);
      }
    };
    const finish = (apply: boolean) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("keydown", key, true);
      document.body.classList.remove("dragging-panel");
      card.classList.remove("moving");
      card.style.transform = "";
      setMovingPanel(null);
      setDockHint(null);
      if (apply && live && at) {
        if (panel === "sidebar") {
          if (at !== "bottom") setSidebarSide(at);
        } else {
          setTermDock(at);
        }
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
  }, []);

  // ----- the grid the panels dock into -----
  // One container, fixed child slots, and every arrangement is nothing but
  // track sizes and cell assignments. That is the load-bearing part: a dock
  // change never moves a component to a different parent, so React never
  // remounts a relocated panel — the terminal keeps its shells through the
  // move, and the editor keeps its undo history. Reading order of the
  // segments is the window's left-to-right; the sidebar stands outermost when
  // it shares a side with the terminal, since it is the panel about the
  // project and the terminal is a panel about the editor beside it.
  const segs: { key: "sidebar" | "sbRes" | "term" | "tRes" | "main"; size: string }[] = [];
  if (sidebarVisible && sidebarSide === "left")
    segs.push({ key: "sidebar", size: `${sidebarWidth}px` }, { key: "sbRes", size: "var(--float-gap)" });
  if (terminalVisible && termDock === "left")
    segs.push({ key: "term", size: `${termWidth}px` }, { key: "tRes", size: "var(--float-gap)" });
  segs.push({ key: "main", size: "minmax(0, 1fr)" });
  if (terminalVisible && termDock === "right")
    segs.push({ key: "tRes", size: "var(--float-gap)" }, { key: "term", size: `${termWidth}px` });
  if (sidebarVisible && sidebarSide === "right")
    segs.push({ key: "sbRes", size: "var(--float-gap)" }, { key: "sidebar", size: `${sidebarWidth}px` });
  const col = (k: (typeof segs)[number]["key"]) => `${segs.findIndex((s) => s.key === k) + 1}`;
  // at the bottom the terminal leaves the columns and takes a full-width row
  // of its own — under the sidebar too, which stops where the terminal starts
  const bottomDock = terminalVisible && termDock === "bottom";
  const termLayout: React.CSSProperties = !terminalVisible
    ? {}
    : bottomDock
      ? { gridColumn: "1 / -1", gridRow: "3" }
      : { gridColumn: col("term"), gridRow: "1" };

  // how far the side panels (each with the gap it floats in) unbalance the
  // window's centre — positive when the left side is heavier. Anything that
  // wants the true centre reads this and backs out half of it.
  const skew: string[] = [];
  if (sidebarVisible)
    skew.push(`${sidebarSide === "left" ? "" : "-1 * "}(${sidebarWidth}px + var(--float-gap))`);
  if (terminalVisible && termDock !== "bottom")
    skew.push(`${termDock === "left" ? "" : "-1 * "}(${termWidth}px + var(--float-gap))`);

  return (
    <div
      ref={rootRef}
      className={`workspace ${active ? "" : "inactive"}`}
      // the tracks ARE the layout: where each panel hangs and how much room it
      // holds are said here and nowhere else — the children only name their
      // cell. Rebuilding the strings per render is nothing; what they describe
      // changes only when a divider or a card is let go of.
      style={
        {
          gridTemplateColumns: segs.map((s) => s.size).join(" "),
          gridTemplateRows: bottomDock
            ? `minmax(0, 1fr) var(--float-gap) ${termHeight}px`
            : "minmax(0, 1fr)",
          "--center-skew": skew.length ? `calc(${skew.join(" + ")})` : "0px",
        } as React.CSSProperties
      }
      onMouseMove={armGrabs}
      onMouseLeave={() => setGrabArmed(null)}
    >
      {sidebarVisible && (
        <Sidebar
          project={project}
          tab={sidebarTab}
          onTab={setSidebarTab}
          onOpenView={openView}
          active={active}
          width={sidebarWidth}
          layout={{ gridColumn: col("sidebar"), gridRow: "1" }}
          search={search}
          memos={memos}
          activeMemo={activeMemo}
          activeKey={shown?.key ?? null}
          reveal={reveal}
          onRevealInTree={revealInTree}
        />
      )}
      {sidebarVisible && (
        <div
          className="resizer-col"
          style={{ gridColumn: col("sbRes"), gridRow: "1" }}
          onMouseDown={(e) =>
            startDrag(e, "x", sidebarSide === "left" ? 1 : -1, sidebarWidth, 170, 560, setSidebarWidth)
          }
        />
      )}
      <div className="main-col" style={{ gridColumn: col("main"), gridRow: "1" }}>
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
      {terminalVisible &&
        (bottomDock ? (
          <div
            className="resizer-row"
            style={{ gridColumn: "1 / -1", gridRow: "2" }}
            onMouseDown={(e) =>
              startDrag(e, "y", -1, termHeight, 100, window.innerHeight - 200, setTermHeight, termCell())
            }
          />
        ) : (
          <div
            className="resizer-col"
            style={{ gridColumn: col("tRes"), gridRow: "1" }}
            onMouseDown={(e) =>
              startDrag(
                e,
                "x",
                termDock === "left" ? 1 : -1,
                termWidth,
                240,
                Math.max(320, window.innerWidth - 400),
                setTermWidth
              )
            }
          />
        ))}
      <Terminals
        tree={term}
        visible={terminalVisible}
        layout={termLayout}
        active={active}
        onOpenFile={openFile}
      />
      {/* the pills a panel is carried by, each lying in its panel's own cell
          so it stays centred over the card without the card knowing */}
      {sidebarVisible && (
        <div
          className={`panel-grab ${grabArmed === "sidebar" ? "armed" : ""} ${
            movingPanel === "sidebar" ? "live" : ""
          }`}
          style={{ gridColumn: col("sidebar"), gridRow: "1" }}
          title="move sidebar"
          onMouseDown={(e) => startPanelMove(e, "sidebar")}
        />
      )}
      {terminalVisible && (
        <div
          className={`panel-grab ${grabArmed === "terminal" ? "armed" : ""} ${
            movingPanel === "terminal" ? "live" : ""
          }`}
          style={termLayout}
          title="move terminal"
          onMouseDown={(e) => startPanelMove(e, "terminal")}
        />
      )}
      {/* the edge the carried card would dock to */}
      {dockHint && <div className={`dock-hint ${dockHint}`} />}
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
