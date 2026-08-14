import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { api } from "./lib/api";
import { Launcher } from "./components/Launcher";
import { Settings } from "./components/Settings";
import { Titlebar } from "./components/Titlebar";
import { Workspace } from "./components/Workspace";
import { moveItem, movedIndex } from "./lib/tabReorder";
import { restoreSession, saveProjects } from "./lib/session";
import "./App.css";

export interface Project {
  root: string;
  name: string;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);

  // Nothing renders until this has settled, and the ordering is the reason.
  // The reap kills every shell the Rust side is still holding, and React runs
  // child effects before parent ones — so restoring the projects in the same
  // commit would have each pane spawn its shell and then be killed by this.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let live = true;
    // fresh frontend boot (including webview reload after a crash):
    // reap any shells a previous page instance left behind
    api
      .ptyKillAll()
      .catch(() => {})
      .then(restoreSession)
      .then((s) => {
        if (!live) return;
        setProjects(s.projects);
        setActiveIdx(s.activeIdx);
      })
      .catch(() => {})
      .finally(() => {
        if (live) setRestored(true);
      });
    return () => {
      live = false;
    };
  }, []);

  // guarded on `restored` so the empty state we start with can't overwrite a
  // stored session before it has been read back
  useEffect(() => {
    if (restored) saveProjects(projects, activeIdx);
  }, [restored, projects, activeIdx]);

  const openProject = useCallback((root: string) => {
    const name = root.split("/").filter(Boolean).pop() ?? root;
    api.addRecent(root).catch(() => {});
    setProjects((prev) => {
      const existing = prev.findIndex((p) => p.root === root);
      if (existing >= 0) {
        setActiveIdx(existing);
        return prev;
      }
      setActiveIdx(prev.length);
      return [...prev, { root, name }];
    });
  }, []);

  // `zero <dir>` in a shell: the command leaves the directory for the app to
  // pick up and the Rust side emits it here, whether zero was already running
  // or has just started up because of it
  useEffect(() => {
    const stop = listen<string>("open-project", (e) => openProject(e.payload));
    return () => {
      stop.then((off) => off()).catch(() => {});
    };
  }, [openProject]);

  const pickProject = useCallback(async () => {
    const dir = await open({ directory: true, multiple: false, title: "Open project" });
    if (typeof dir === "string") openProject(dir);
  }, [openProject]);

  const reorderProjects = useCallback((from: number, to: number) => {
    setProjects((prev) => {
      if (from === to || from < 0 || to < 0 || from >= prev.length || to >= prev.length) return prev;
      // the active project is an index, so it has to travel with the move
      setActiveIdx((cur) => movedIndex(cur, from, to));
      return moveItem(prev, from, to);
    });
  }, []);

  const closeProject = useCallback((idx: number) => {
    setProjects((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      setActiveIdx((cur) => Math.min(cur > idx ? cur - 1 : cur, Math.max(next.length - 1, 0)));
      return next;
    });
  }, []);

  // UI zoom, cmd+/- like Cursor
  const [zoom, setZoom] = useState(() => {
    const v = parseFloat(localStorage.getItem("zero-zoom") ?? "");
    return Number.isFinite(v) ? v : 1;
  });
  useEffect(() => {
    // native webview zoom, not CSS `zoom`: the CSS one scales layout but not
    // the mouse coordinates JS sees, which threw off xterm's selection maths
    // and every drag handle by exactly the zoom factor
    getCurrentWebview().setZoom(zoom).catch(() => {});
    localStorage.setItem("zero-zoom", String(zoom));
  }, [zoom]);

  const [showSettings, setShowSettings] = useState(false);

  // zero → Preferences… in the menu bar; the keyboard path is ⌘, below
  useEffect(() => {
    const stop = listen("open-settings", () => setShowSettings(true));
    return () => {
      stop.then((off) => off()).catch(() => {});
    };
  }, []);

  // Global keys: cmd+` / cmd+shift+` cycle projects, cmd+shift+O / cmd+shift+N
  // open a project, cmd+/-/0 zoom, cmd+, settings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === ",") {
        e.preventDefault();
        setShowSettings((s) => !s);
      } else if (e.code === "Backquote") {
        e.preventDefault();
        if (projects.length > 1) {
          setActiveIdx((i) => (i + (e.shiftKey ? projects.length - 1 : 1)) % projects.length);
        }
      } else if (e.shiftKey && (e.key.toLowerCase() === "o" || e.key.toLowerCase() === "n")) {
        e.preventDefault();
        pickProject();
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => Math.min(Math.round((z + 0.1) * 10) / 10, 2));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom((z) => Math.max(Math.round((z - 0.1) * 10) / 10, 0.5));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [projects.length, pickProject]);

  // one IPC round trip, and showing the launcher for that frame would mean a
  // flash of it every launch on the way to the projects that were already open
  if (!restored) return null;

  // rendered in both branches: ⌘, should work from the launcher too
  const settings = showSettings ? <Settings onClose={() => setShowSettings(false)} /> : null;

  if (projects.length === 0) {
    return (
      <>
        <Launcher onOpen={openProject} onPick={pickProject} />
        {settings}
      </>
    );
  }

  return (
    <div className="app">
      <Titlebar
        projects={projects}
        activeIdx={activeIdx}
        onSwitch={setActiveIdx}
        onClose={closeProject}
        onReorder={reorderProjects}
        onPick={pickProject}
        onSettings={() => setShowSettings(true)}
      />
      <div className="workspaces">
        {projects.map((p, i) => (
          <Workspace key={p.root} project={p} active={i === activeIdx} />
        ))}
      </div>
      {settings}
    </div>
  );
}
