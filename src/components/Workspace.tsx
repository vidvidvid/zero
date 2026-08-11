import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "../App";
import { Sidebar, SidebarTab } from "./Sidebar";
import { EditorPane } from "./EditorPane";
import { Terminals, useTerminalTree } from "./Terminals";
import { QuickOpen } from "./QuickOpen";
import { moveItem, movedIndex } from "../lib/tabReorder";
import { projectSession, saveProject } from "../lib/session";

export type View =
  | { kind: "diff"; key: string; worktree: string; relPath: string }
  | { kind: "file"; key: string; absPath: string; line?: number }
  | { kind: "new"; key: string; name: string };

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

function persisted(key: string, fallback: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? "");
  return Number.isFinite(v) ? v : fallback;
}

/** a pane's vertical padding — the part of the panel's height that isn't rows */
const PANE_PAD_Y = 12;

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
  const [termHeight, setTermHeight] = useState(() => persisted("zero-term-h", 300));
  const [views, setViews] = useState<View[]>(saved.views ?? []);
  const [activeView, setActiveView] = useState(saved.activeView ?? 0);
  const untitledRef = useRef(0);
  const term = useTerminalTree(project.root, saved);

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
      if (meta && !e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarVisible((v) => !v);
      } else if ((meta && e.key.toLowerCase() === "j" && !e.shiftKey) || (ctrl && e.code === "Backquote" && !e.shiftKey)) {
        e.preventDefault();
        setTerminalVisible((v) => !v);
      } else if (meta && !e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        closeView(activeViewRefValue.current);
      } else if (meta && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setSidebarVisible(true);
        setSidebarTab("files");
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setSidebarVisible(true);
        setSidebarTab("scm");
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
      } else if (meta && e.key === "\\") {
        e.preventDefault();
        setTerminalVisible(true);
        term.splitFocused(e.shiftKey ? "col" : "row");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, closeView, openView, project.root, term.newTerminal, term.splitFocused]);

  // keep a ref-like holder for activeView so the key handler doesn't rebind constantly
  const activeViewRefValue = useStateRef(activeView);

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
            root={project.root}
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
        onOpenFile={(abs, line) => openView({ kind: "file", key: `file:${abs}`, absPath: abs, line })}
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
