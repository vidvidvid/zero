import { useEffect, useState } from "react";
import { api, RecentProject } from "../lib/api";
import { contextMenu, fileEntries } from "../lib/contextMenu";

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
        {/* both here: the mark over the name. The launcher is the one screen
            with room for an introduction, and the empty editor — where the
            mark stands alone — is not. */}
        <div className="launcher-mark" role="img" aria-label="zero" />
        <h1 className="launcher-logo">zero</h1>
        {/* under the mark rather than in a corner: it reads as part of it,
            which is the one place a version can sit without ever being in the
            way of something */}
        <div className="launcher-version">{__APP_VERSION__}</div>
        <div className="launcher-recents">
          {recents.map((r) => (
            <button
              key={r.path}
              className="launcher-item"
              onClick={() => onOpen(r.path)}
              // "Remove from Recents" is the item this list has been missing:
              // a project that has moved leaves a row that opens nothing, and
              // there was no way to be rid of it short of opening others until
              // it fell off the end
              onContextMenu={(e) =>
                contextMenu(e, [
                  { text: "Open Project", run: () => onOpen(r.path) },
                  {
                    text: "Remove from Recents",
                    run: () =>
                      api
                        .removeRecent(r.path)
                        .then(() => setRecents((prev) => prev.filter((x) => x.path !== r.path))),
                  },
                  "sep",
                  ...fileEntries(r.path, { isDir: true, writes: "none" }),
                ])
              }
            >
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
