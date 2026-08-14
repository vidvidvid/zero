import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "../App";
import { Sidebar, SidebarTab } from "./Sidebar";
import type { Reveal } from "./FileTree";
import { EditorPane } from "./EditorPane";
import { Terminals, useTerminalTree } from "./Terminals";
import { QuickOpen } from "./QuickOpen";
import { moveItem, movedIndex } from "../lib/tabReorder";
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
    (id) => openView({ kind: "memo", key: `memo:${id}`, id })
  );

  useEffect(() => {
    localStorage.setItem("zero-sidebar-w", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem("zero-term-h", String(termHeight));
  }, [termHeight]);

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

  const closeView = useCallback((idx: number) => {
    setViews((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      setActiveView((cur) => Math.min(cur > idx ? cur - 1 : cur, Math.max(next.length - 1, 0)));
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
      } else if (meta && e.key.toLowerCase() === "e") {
        // the tree opens on the file you're looking at, folders and all —
        // ⌘⇧E does it too, since that's the one people arrive with
        e.preventDefault();
        setSidebarVisible(true);
        setSidebarTab("files");
        const v = viewsRef.current[activeViewRefValue.current];
        const abs =
          v?.kind === "file" ? v.absPath : v?.kind === "diff" ? `${v.worktree}/${v.relPath}` : null;
        if (abs) setReveal({ path: abs, n: revealCount.current++ });
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
  }, [active, closeView, openView, project.root, search.focus, term.newTerminal, term.splitFocused]);

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

  return (
    <div
      ref={rootRef}
      className={`workspace ${active ? "" : "inactive"}`}
      // how much width the sidebar (plus its resizer) is stealing from the
      // right-hand side — anything that wants the window's centre reads this
      style={
        {
          "--sidebar-offset": sidebarVisible ? `${sidebarWidth + 2}px` : "0px",
        } as React.CSSProperties
      }
    >
      {/* the terminal spans the window, so the sidebar stops where it starts
          rather than running the full height beside it */}
      <div className="workspace-top">
        {sidebarVisible && (
          <>
            <Sidebar
              project={project}
              tab={sidebarTab}
              onTab={setSidebarTab}
              onOpenView={openView}
              active={active}
              width={sidebarWidth}
              search={search}
              memos={memos}
              activeMemo={activeMemo}
              reveal={reveal}
            />
            <div
              className="resizer-col"
              onMouseDown={(e) => startDrag(e, "x", 1, sidebarWidth, 170, 560, setSidebarWidth)}
            />
          </>
        )}
        <div className="main-col">
          <EditorPane
            views={views}
            activeView={activeView}
            onSelect={setActiveView}
            onClose={closeView}
            onReplace={replaceView}
            onReorder={reorderViews}
            onOpenFile={openFile}
            root={project.root}
            // a memo tab draws its own live title and records its own
            // follow-ups, both of which are this object
            memos={memos}
          />
        </div>
      </div>
      {terminalVisible && (
        <div
          className="resizer-row"
          onMouseDown={(e) =>
            startDrag(e, "y", -1, termHeight, 100, window.innerHeight - 200, setTermHeight, termCell())
          }
        />
      )}
      <Terminals
        tree={term}
        visible={terminalVisible}
        height={termHeight}
        active={active}
        onOpenFile={openFile}
      />
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
