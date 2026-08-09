import { useEffect, useState } from "react";
import { api, DirEntry } from "../lib/api";
import { FileIconSpan } from "./FileIcon";
import { Chevron } from "./Chevron";
import type { View } from "./Workspace";

function Node({
  path,
  entry,
  depth,
  onOpenView,
}: {
  path: string;
  entry: DirEntry;
  depth: number;
  onOpenView: (v: View) => void;
}) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const full = `${path}/${entry.name}`;

  useEffect(() => {
    if (open && children === null) {
      api.listDir(full).then(setChildren).catch(() => setChildren([]));
    }
  }, [open, children, full]);

  if (!entry.is_dir) {
    return (
      <button
        className="tree-item file"
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => onOpenView({ kind: "file", key: `file:${full}`, absPath: full })}
      >
        <FileIconSpan name={entry.name} />
        {entry.name}
      </button>
    );
  }

  return (
    <>
      <button
        className="tree-item dir"
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => setOpen((v) => !v)}
      >
        <Chevron open={open} className="tree-arrow" />
        {entry.name}
      </button>
      {open &&
        children?.map((c) => (
          <Node key={c.name} path={full} entry={c} depth={depth + 1} onOpenView={onOpenView} />
        ))}
    </>
  );
}

export function FileTree({ root, onOpenView }: { root: string; onOpenView: (v: View) => void }) {
  const [entries, setEntries] = useState<DirEntry[]>([]);

  useEffect(() => {
    api.listDir(root).then(setEntries).catch(() => setEntries([]));
  }, [root]);

  return (
    <div className="file-tree">
      {entries.map((e) => (
        <Node key={e.name} path={root} entry={e} depth={0} onOpenView={onOpenView} />
      ))}
    </div>
  );
}
