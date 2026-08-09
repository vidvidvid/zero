import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "../App";
import { Sidebar, SidebarTab } from "./Sidebar";
import { EditorPane } from "./EditorPane";
import { Terminals, useTerminalTree } from "./Terminals";
import { QuickOpen } from "./QuickOpen";
import { moveItem, movedIndex } from "../lib/tabReorder";

export type View =
  | { kind: "diff"; key: string; worktree: string; relPath: string }
  | { kind: "file"; key: string; absPath: string; line?: number }
  | { kind: "new"; key: string; name: string };

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);

function persisted(key: string, fallback: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? "");
  return Number.isFinite(v) ? v : fallback;
}

/** the terminal's line height, so a drag can move in whole rows */
function termCell(): number {
  const row = document.querySelector<HTMLElement>(".xterm-rows > div");
  return row?.getBoundingClientRect().height ?? 0;
}

function startDrag(
  e: React.MouseEvent,
  axis: "x" | "y",
  dir: 1 | -1,
  start: number,
  min: number,
  max: number,
  set: (v: number) => void,
  /** move in multiples of this many pixels, if given */
  step = 0
) {
  e.preventDefault();
  const startPos = axis === "x" ? e.clientX : e.clientY;
  document.body.classList.add(axis === "x" ? "dragging-col" : "dragging-row");
  const move = (ev: MouseEvent) => {
    const moved = (axis === "x" ? ev.clientX : ev.clientY) - startPos;
    const delta = step > 1 ? Math.round(moved / step) * step : moved;
    set(clamp(start + dir * delta, min, max));
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
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("scm");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [terminalVisible, setTerminalVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => persisted("zero-sidebar-w", 260));
  const [quickOpen, setQuickOpen] = useState(false);
  const [termHeight, setTermHeight] = useState(() => persisted("zero-term-h", 300));
  const [views, setViews] = useState<View[]>([]);
  const [activeView, setActiveView] = useState(0);
  const untitledRef = useRef(0);
  const term = useTerminalTree(project.root);

  useEffect(() => {
    localStorage.setItem("zero-sidebar-w", String(sidebarWidth));
  }, [sidebarWidth]);
  useEffect(() => {
    localStorage.setItem("zero-term-h", String(termHeight));
  }, [termHeight]);

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

  return (
    <div
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
            // in whole rows: a terminal holds a whole number of them and pads
            // with what's left, so moving by anything else changes the padding
            // on every side as you drag
            startDrag(e, "y", -1, termHeight, 100, window.innerHeight - 200, setTermHeight, termCell())
          }
        />
      )}
      <Terminals tree={term} visible={terminalVisible} height={termHeight} active={active} />
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
