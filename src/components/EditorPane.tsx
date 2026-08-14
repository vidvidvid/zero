import { useEffect } from "react";
import type { View } from "./Workspace";
import { DiffView } from "./DiffView";
import { FileView } from "./FileView";
import { ImageView } from "./ImageView";
import { MemoThread } from "./MemoThread";
import { NewFileView } from "./NewFileView";
import { isImage } from "../lib/imageFile";
import { FileIconSpan } from "./FileIcon";
import { memoLabel, memoPaths, type Memos } from "../lib/memos";
import { useTabReorder } from "../lib/tabReorder";

function viewLabel(v: View, memos: Memos): string {
  if (v.kind === "new") return v.name;
  // The memo's own title, live: a merge renames it, and the tab is where that
  // name is said — the thread below draws no title of its own, precisely so
  // this one isn't a second copy of it. Gone from the list and it is down to
  // the id, which is still what its files are called.
  if (v.kind === "memo") return memoLabel(memos.memos.find((m) => m.id === v.id), v.id);
  const p = v.kind === "diff" ? v.relPath : v.absPath;
  return p.split("/").pop() ?? p;
}

function viewAbs(v: View, root: string): string {
  if (v.kind === "new") return v.name;
  // a thread is a reading of a file, and this is the file — which is worth
  // saying in the one line of chrome that says where you are
  if (v.kind === "memo") return memoPaths(root, v.id).md;
  return v.kind === "diff" ? `${v.worktree}/${v.relPath}` : v.absPath;
}

// path shown in the breadcrumb: relative to the project when it lives inside it
function viewPath(v: View, root: string): string {
  const abs = viewAbs(v, root);
  if (v.kind === "new") return abs;
  if (abs.startsWith(root + "/")) return abs.slice(root.length + 1);
  return abs.replace(/^\/Users\/[^/]+\//, "~/");
}

function Breadcrumb({
  view,
  root,
  onOpenFile,
}: {
  view: View;
  root: string;
  onOpenFile: (abs: string) => void;
}) {
  const abs = viewAbs(view, root);
  const parts = viewPath(view, root).split("/");
  const name = parts.pop() ?? "";
  // A thread is a reading of a file, and this line is the one place that says
  // which file — so it is also the way to it. Every other view already *is* its
  // file, and a path that opened the tab you are standing on would be a click
  // that does nothing. Coming back is the thread's own tab, still open.
  const open = view.kind === "memo" ? () => onOpenFile(abs) : undefined;
  return (
    <div
      className={`editor-path ${open ? "opens" : ""}`}
      title={open ? `${abs} — open the file itself` : abs}
      onClick={open}
    >
      {parts.map((p, i) => (
        <span key={i} className="crumb">
          {p}
          <span className="crumb-sep">›</span>
        </span>
      ))}
      <span className="crumb file">
        <FileIconSpan name={name} />
        {name}
      </span>
    </div>
  );
}

export function EditorPane({
  views,
  activeView,
  onSelect,
  onClose,
  onReplace,
  onOpenFile,
  onReorder,
  root,
  memos,
}: {
  views: View[];
  activeView: number;
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  onReplace: (i: number, v: View) => void;
  onOpenFile: (abs: string, line?: number) => void;
  onReorder: (from: number, to: number) => void;
  root: string;
  /** this project's memos — a memo tab reads its title, its status and its
   *  record button off the same object the panel does */
  memos: Memos;
}) {
  const { stripRef, drag, start: startDrag, shift } = useTabReorder(".editor-tab", onReorder);

  // The strip scrolls, and most of what activates a tab is somewhere else: a
  // memo row, a search hit, ⌘P, a memo that came back and opened itself. With
  // enough tabs open the one being activated sits past the right-hand edge, and
  // a click that changes nothing you can see is a click that did nothing —
  // which is exactly how "it doesn't take you to that tab" was reported.
  //
  // Not while dragging: mid-gesture the tabs are translated rather than moved,
  // so their boxes lie about where they are, and a scroll would fight the hand.
  useEffect(() => {
    if (drag) return;
    stripRef.current
      ?.querySelector(".editor-tab.active")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeView, drag, stripRef]);

  if (views.length === 0) {
    return (
      <div className="editor-pane empty">
        <div className="editor-empty-hint">zero</div>
      </div>
    );
  }

  return (
    <div className="editor-pane">
      <div className={`editor-tabs ${drag ? "reordering" : ""}`} ref={stripRef}>
        {views.map((v, i) => (
          <div
            key={v.key}
            className={`editor-tab ${i === activeView ? "active" : ""} ${
              drag?.from === i ? "dragging" : ""
            }`}
            style={{ transform: shift(i) }}
            onMouseDown={(e) => {
              if (e.button === 1) onClose(i);
              else if (e.button === 0) {
                onSelect(i);
                startDrag(e, i);
              }
            }}
          >
            <button className="editor-tab-name" onClick={() => onSelect(i)} title={v.key}>
              {/* the two diffs of one file are two tabs, so the marker has to
                  tell them apart — ✓ is the staged one, already accounted for */}
              {v.kind === "diff" && (
                <span className={`editor-tab-diff ${v.staged ? "staged" : ""}`}>
                  {v.staged ? "✓" : "±"}
                </span>
              )}
              {viewLabel(v, memos)}
            </button>
            <button
              className="editor-tab-close"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onClose(i)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      {views[activeView] && (
        <Breadcrumb view={views[activeView]} root={root} onOpenFile={onOpenFile} />
      )}
      <div className="editor-body">
        {views.map((v, i) => (
          <div key={v.key} className="editor-view" style={{ display: i === activeView ? "block" : "none" }}>
            {v.kind === "diff" ? (
              <DiffView
                worktree={v.worktree}
                relPath={v.relPath}
                staged={v.staged}
                visible={i === activeView}
              />
            ) : v.kind === "memo" ? (
              <MemoThread root={root} id={v.id} memos={memos} visible={i === activeView} />
            ) : v.kind === "new" ? (
              <NewFileView
                root={root}
                onSaved={(absPath) => onReplace(i, { kind: "file", key: `file:${absPath}`, absPath })}
              />
            ) : isImage(v.absPath) ? (
              <ImageView absPath={v.absPath} />
            ) : (
              <FileView
                absPath={v.absPath}
                line={v.line}
                visible={i === activeView}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
