import { useEffect, useState } from "react";
import { api, RecentProject } from "../lib/api";

export function Launcher({
  onOpen,
  onPick,
}: {
  onOpen: (root: string) => void;
  onPick: () => void;
}) {
  const [recents, setRecents] = useState<RecentProject[]>([]);

  useEffect(() => {
    api.getRecents().then(setRecents).catch(() => {});
  }, []);

  return (
    <div className="launcher" data-tauri-drag-region>
      <div className="launcher-inner">
        <h1 className="launcher-logo">zero</h1>
        <div className="launcher-recents">
          {recents.map((r) => (
            <button key={r.path} className="launcher-item" onClick={() => onOpen(r.path)}>
              <span className="launcher-item-name">{r.name}</span>
              <span className="launcher-item-path">{r.path.replace(/^\/Users\/[^/]+/, "~")}</span>
            </button>
          ))}
          {recents.length === 0 && <div className="launcher-empty">no recent projects</div>}
        </div>
        <button className="launcher-open" onClick={onPick}>
          open project… <kbd>⌘⇧O</kbd>
        </button>
      </div>
    </div>
  );
}
