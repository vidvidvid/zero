import type { ReactElement } from "react";
import type { Project } from "../App";
import type { View } from "./Workspace";
import { WorktreePanel } from "./WorktreePanel";
import { FileTree } from "./FileTree";
import { SearchPanel } from "./SearchPanel";

export type SidebarTab = "scm" | "files" | "search";

// VS Code / Cursor activity-bar codicons: source-control, files, search
const ICONS: Record<SidebarTab, ReactElement> = {
  scm: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="4.5" cy="3.2" r="1.7" />
      <circle cx="4.5" cy="12.8" r="1.7" />
      <circle cx="11.5" cy="6" r="1.7" />
      <path d="M4.5 4.9v6.2" />
      <path d="M11.5 7.7c0 2.4-2.3 3.2-4.6 3.6" strokeLinecap="round" />
    </svg>
  ),
  files: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M9.2 1.8H4.3a.9.9 0 0 0-.9.9v8.6" strokeLinecap="round" />
      <path d="M6.6 4.4h3.9l2.1 2.1v6.8a.9.9 0 0 1-.9.9H6.6a.9.9 0 0 1-.9-.9V5.3a.9.9 0 0 1 .9-.9Z" />
      <path d="M10.4 4.5v2.2h2.1" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="6.9" cy="6.9" r="4.4" />
      <path d="m10.2 10.2 3.3 3.3" strokeLinecap="round" />
    </svg>
  ),
};

const TABS: { id: SidebarTab; title: string }[] = [
  { id: "scm", title: "changes (⌃⇧G)" },
  { id: "files", title: "files (⌘⇧E)" },
  { id: "search", title: "search (⌘⇧F)" },
];

export function Sidebar({
  project,
  tab,
  onTab,
  onOpenView,
  active,
  width,
}: {
  project: Project;
  tab: SidebarTab;
  onTab: (t: SidebarTab) => void;
  onOpenView: (v: View) => void;
  active: boolean;
  width: number;
}) {
  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`sidebar-tab ${tab === t.id ? "active" : ""}`}
            title={t.title}
            onClick={() => onTab(t.id)}
          >
            {ICONS[t.id]}
          </button>
        ))}
      </div>
      <div className="sidebar-body">
        {tab === "scm" && <WorktreePanel project={project} onOpenView={onOpenView} active={active} />}
        {tab === "files" && <FileTree root={project.root} onOpenView={onOpenView} />}
        {tab === "search" && <SearchPanel root={project.root} onOpenView={onOpenView} />}
      </div>
    </div>
  );
}
