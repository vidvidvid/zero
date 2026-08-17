import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { contextMenu, fileEntries } from "../lib/contextMenu";
import { matchedIndices, rankPaths } from "../lib/fuzzy";
import { FileIconSpan } from "./FileIcon";

/** More than fits on screen twice over; nobody scrolls a fuzzy list. */
const LIMIT = 50;

/** Wrap the letters the query actually matched, in runs rather than per-char. */
function marked(text: string, offset: number, hit: Set<number>): ReactNode {
  if (hit.size === 0) return text;
  const out: ReactNode[] = [];
  let buf = "";
  let on = false;
  const flush = () => {
    if (!buf) return;
    out.push(on ? <b className="quick-hit" key={out.length}>{buf}</b> : buf);
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const lit = hit.has(offset + i);
    if (lit !== on) {
      flush();
      on = lit;
    }
    buf += text[i];
  }
  flush();
  return out;
}

export function QuickOpen({
  root,
  onPick,
  onClose,
}: {
  root: string;
  onPick: (relPath: string) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // listed fresh on every open, so a file written a minute ago is in it
  useEffect(() => {
    let stop = false;
    api
      .projectFiles(root)
      .then((f) => !stop && setFiles(f))
      .catch(() => !stop && setFiles([]));
    return () => {
      stop = true;
    };
  }, [root]);

  const results = useMemo(() => rankPaths(files, query, LIMIT), [files, query]);

  useEffect(() => setAt(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector(".quick-item.on")?.scrollIntoView({ block: "nearest" });
  }, [at, results]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "n")) {
      e.preventDefault();
      setAt((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key.toLowerCase() === "p")) {
      e.preventDefault();
      setAt((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[at]) onPick(results[at].path);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="quick-backdrop" onMouseDown={onClose}>
      <div className="quick-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="quick-input"
          placeholder="go to file…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          autoFocus
        />
        <div className="quick-list" ref={listRef}>
          {results.map((r, i) => {
            const cut = r.path.lastIndexOf("/");
            const name = cut < 0 ? r.path : r.path.slice(cut + 1);
            const dir = cut < 0 ? "" : r.path.slice(0, cut);
            const hit = matchedIndices(r.path, query);
            return (
              <button
                key={r.path}
                className={`quick-item ${i === at ? "on" : ""}`}
                onMouseMove={() => setAt(i)}
                onClick={() => onPick(r.path)}
                onContextMenu={(e) =>
                  contextMenu(e, [
                    { text: "Open", run: () => onPick(r.path) },
                    "sep",
                    ...fileEntries(`${root}/${r.path}`, { root }),
                  ])
                }
              >
                <FileIconSpan name={name} />
                <span className="quick-name">{marked(name, cut + 1, hit)}</span>
                {dir && <span className="quick-dir">{marked(dir, 0, hit)}</span>}
              </button>
            );
          })}
          {results.length === 0 && (
            <div className="quick-empty">{files.length ? "no matching files" : "no files"}</div>
          )}
        </div>
      </div>
    </div>
  );
}
