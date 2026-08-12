import { useEffect, useState } from "react";
import type { Project } from "../App";
import { useClaudeStatus } from "../lib/claudeStatus";
import { useTabReorder } from "../lib/tabReorder";

const sameSet = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((v) => b.has(v));


export function Titlebar({
  projects,
  activeIdx,
  onSwitch,
  onClose,
  onReorder,
  onPick,
}: {
  projects: Project[];
  activeIdx: number;
  onSwitch: (i: number) => void;
  onClose: (i: number) => void;
  onReorder: (from: number, to: number) => void;
  onPick: () => void;
}) {
  const claude = useClaudeStatus(projects.map((p) => p.root));
  const activeRoot = projects[activeIdx]?.root;

  // "finished" is an unread badge: being in the project reads it, and only a
  // session starting work again makes it unread once more
  const [seen, setSeen] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSeen((prev) => {
      const next = new Set(prev);
      for (const p of projects) {
        if (p.root === activeRoot) next.add(p.root);
        else if ((claude[p.root]?.working ?? 0) > 0) next.delete(p.root);
      }
      return sameSet(prev, next) ? prev : next;
    });
  }, [claude, projects, activeRoot]);

  const { stripRef, drag, start: startDrag, shift } = useTabReorder(".titlebar-tab", onReorder);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="titlebar-spacer" data-tauri-drag-region />
      <div className={`titlebar-tabs ${drag ? "reordering" : ""}`} ref={stripRef}>
        {projects.map((p, i) => (
          <div
            key={p.root}
            className={`titlebar-tab ${i === activeIdx ? "active" : ""} ${
              drag?.from === i ? "dragging" : ""
            }`}
            style={{ transform: shift(i) }}
            onMouseDown={(e) => {
              // middle-click closes, left click switches and may start a drag
              if (e.button === 1) onClose(i);
              else if (e.button === 0) {
                onSwitch(i);
                startDrag(e, i);
              }
            }}
            title={p.root}
          >
            {/* always rendered, even empty: the slot is the same fixed square
                as the close button, so a tab never changes width when a
                session starts and the row never shuffles under the cursor */}
            <span className="titlebar-tab-status">
              {(() => {
                const c = claude[p.root];
                const working = c?.working ?? 0;
                // Working shows on every tab, the one you're on included:
                // switching to a project isn't the same as its work being
                // over, and a spinner that vanished when you looked at it made
                // the tab strip disagree with the terminal underneath it.
                // Finished is the one that's genuinely about you — it clears
                // by being read, which is what `seen` tracks.
                const done = seen.has(p.root) ? 0 : (c?.done ?? 0);
                if (!working && !done) return null;
                return (
                  <span
                    className={`claude-ring ${working ? "working" : "done"}`}
                    title={
                      working
                        ? `${working} claude working`
                        : `${done} claude finished — waiting for you`
                    }
                  />
                );
              })()}
            </span>
            <span className="titlebar-tab-name">{p.name}</span>
            <button
              className="titlebar-tab-close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onClose(i)}
              title="close project"
            >
              {/* drawn rather than the × glyph, which sits off-centre in its
                  em box and never lines up with the status dot */}
              <svg width="9" height="9" viewBox="0 0 9 9">
                <path
                  d="M1 1 L8 8 M8 1 L1 8"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        ))}
      </div>
      {/* the + lives in the right-hand spacer, not in the tab strip: inside it
          it counted towards the centred group's width and pushed every tab off
          the window's axis. Out here the two spacers stay equal, so the tabs
          are centred and the button simply follows them. */}
      <div className="titlebar-spacer" data-tauri-drag-region>
        <button className="titlebar-add" title="open project (⌘⇧N / ⌘⇧O)" onClick={onPick}>
          ＋
        </button>
      </div>
    </div>
  );
}
