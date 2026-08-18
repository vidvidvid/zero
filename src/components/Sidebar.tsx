import type { CSSProperties, ReactElement } from "react";
import type { Project } from "../App";
import type { View } from "./Workspace";
import { WorktreePanel } from "./WorktreePanel";
import { FileTree, type Reveal } from "./FileTree";
import { SearchPanel } from "./SearchPanel";
import { MemoPanel } from "./MemoPanel";
import type { Search } from "../lib/search";
import type { Memos } from "../lib/memos";

export type SidebarTab = "scm" | "files" | "search" | "memos";

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
  search: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.1 10.1 13.5 13.5" strokeLinecap="round" />
    </svg>
  ),
  // capsule, cradle, stem — no base foot, and no waveform bars, which would
  // promise playback this doesn't have. The cradle is a true semicircle so the
  // glyph fills the same 1.5–14.5 the branch does; a mic is narrower than the
  // other three by nature and pretending otherwise makes it a cartoon.
  memos: (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="6.3" y="2.1" width="3.4" height="6.4" rx="1.7" />
      <path d="M4 7.4v1.1a4 4 0 0 0 8 0V7.4" strokeLinecap="round" />
      <path d="M8 12.5v1.4" strokeLinecap="round" />
    </svg>
  ),
};

const TABS: { id: SidebarTab; title: string }[] = [
  { id: "files", title: "files (⌘⇧E)" },
  { id: "search", title: "search (⌘⇧F)" },
  { id: "scm", title: "changes (⌃⇧G)" },
  { id: "memos", title: "memos (⌘⇧M)" },
];

export function Sidebar({
  project,
  tab,
  onTab,
  onOpenView,
  active,
  width,
  layout,
  search,
  memos,
  activeMemo,
  activeKey,
  reveal,
  onRevealInTree,
}: {
  project: Project;
  tab: SidebarTab;
  onTab: (t: SidebarTab) => void;
  onOpenView: (v: View) => void;
  active: boolean;
  width: number;
  /** which cell of the workspace's grid this panel lives in — the side it
   *  hangs on is the grid's business, not this component's */
  layout: CSSProperties;
  search: Search;
  memos: Memos;
  /** the memo whose thread is the view on screen, so its row can say so —
   *  passed straight through, since the sidebar knows nothing about tabs */
  activeMemo: string | null;
  /** the shown view's key, for the same reason: the changes row whose diff or
   *  file is on screen marks itself */
  activeKey: string | null;
  reveal: Reveal | null;
  /** walk the file tree open to a path and light its row — ⌘E's other half,
   *  offered as a menu item by the panels that name files they didn't find */
  onRevealInTree: (abs: string) => void;
}) {
  // The memos tab is the only one that has anything to say while you're not
  // looking at it, and this dot is all of it — no titlebar presence, no
  // notifications, no sound. Red beats everything because a live mic may never
  // be invisible; then work in progress; then a memo that came back unread.
  const dot = memos.recording
    ? "rec"
    : memos.working
      ? "busy"
      : memos.unseenReady
        ? "ready"
        : "";

  return (
    <div className="sidebar" style={{ width, ...layout }}>
      <div className="sidebar-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`sidebar-tab ${tab === t.id ? "active" : ""}`}
            title={t.title}
            onClick={() => onTab(t.id)}
          >
            {ICONS[t.id]}
            {t.id === "memos" && dot && <span className={`memo-tab-dot ${dot}`} />}
          </button>
        ))}
      </div>
      <div className="sidebar-body">
        {tab === "scm" && (
          <WorktreePanel
            project={project}
            onOpenView={onOpenView}
            onRevealInTree={onRevealInTree}
            active={active}
            activeKey={activeKey}
          />
        )}
        {tab === "files" && (
          <FileTree
            root={project.root}
            active={active}
            reveal={reveal}
            onOpenView={onOpenView}
          />
        )}
        {tab === "search" && (
          <SearchPanel
            root={project.root}
            search={search}
            onOpenView={onOpenView}
            onRevealInTree={onRevealInTree}
          />
        )}
        {tab === "memos" && (
          <MemoPanel
            root={project.root}
            memos={memos}
            activeMemo={activeMemo}
            onOpenView={onOpenView}
          />
        )}
      </div>
    </div>
  );
}
