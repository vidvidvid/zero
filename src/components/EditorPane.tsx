import type { View } from "./Workspace";
import { DiffView } from "./DiffView";
import { FileView } from "./FileView";
import { NewFileView } from "./NewFileView";
import { FileIconSpan } from "./FileIcon";
import { useTabReorder } from "../lib/tabReorder";

function viewLabel(v: View): string {
  if (v.kind === "new") return v.name;
  const p = v.kind === "diff" ? v.relPath : v.absPath;
  return p.split("/").pop() ?? p;
}

function viewAbs(v: View): string {
  if (v.kind === "new") return v.name;
  return v.kind === "diff" ? `${v.worktree}/${v.relPath}` : v.absPath;
}

// path shown in the breadcrumb: relative to the project when it lives inside it
function viewPath(v: View, root: string): string {
  const abs = viewAbs(v);
  if (v.kind === "new") return abs;
  if (abs.startsWith(root + "/")) return abs.slice(root.length + 1);
  return abs.replace(/^\/Users\/[^/]+\//, "~/");
}

function Breadcrumb({ view, root }: { view: View; root: string }) {
  const parts = viewPath(view, root).split("/");
  const name = parts.pop() ?? "";
  return (
    <div className="editor-path" title={viewAbs(view)}>
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
}: {
  views: View[];
  activeView: number;
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  onReplace: (i: number, v: View) => void;
  onOpenFile: (abs: string, line?: number) => void;
  onReorder: (from: number, to: number) => void;
  root: string;
}) {
  const { stripRef, drag, start: startDrag, shift } = useTabReorder(".editor-tab", onReorder);

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
              {v.kind === "diff" && <span className="editor-tab-diff">±</span>}
              {viewLabel(v)}
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
      {views[activeView] && <Breadcrumb view={views[activeView]} root={root} />}
      <div className="editor-body">
        {views.map((v, i) => (
          <div key={v.key} className="editor-view" style={{ display: i === activeView ? "block" : "none" }}>
            {v.kind === "diff" ? (
              <DiffView worktree={v.worktree} relPath={v.relPath} visible={i === activeView} />
            ) : v.kind === "new" ? (
              <NewFileView
                root={root}
                onSaved={(absPath) => onReplace(i, { kind: "file", key: `file:${absPath}`, absPath })}
              />
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
