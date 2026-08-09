import type { ReactElement } from "react";
import type { Project } from "../App";
import type { View } from "./Workspace";
import { WorktreePanel } from "./WorktreePanel";
import { FileTree } from "./FileTree";

export type SidebarTab = "scm" | "files";

// activity-bar glyphs, drawn to the same 16px / 1.2-stroke grid
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
  // a folder, not VS Code's two stacked pages — at 16px that codicon reads as
  // a copy/duplicate glyph, and it sat next to a branch icon that also has two
  // of something
  files: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path
        d="M2.3 11.8V4.5a.9.9 0 0 1 .9-.9h2.5l1.5 1.7h5.6a.9.9 0 0 1 .9.9v5.6a.9.9 0 0 1-.9.9H3.2a.9.9 0 0 1-.9-.9Z"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

const TABS: { id: SidebarTab; title: string }[] = [
  { id: "files", title: "files (⌘⇧E)" },
  { id: "scm", title: "changes (⌃⇧G)" },
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
      </div>
    </div>
  );
}
