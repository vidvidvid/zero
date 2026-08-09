import { useEffect, useRef, useState } from "react";
import { api, SearchHit } from "../lib/api";
import type { View } from "./Workspace";

export function SearchPanel({ root, onOpenView }: { root: string; onOpenView: (v: View) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!query.trim()) {
        setHits([]);
        setError(null);
        return;
      }
      api
        .search(root, query)
        .then((h) => {
          setHits(h);
          setError(null);
        })
        .catch((e) => setError(String(e)));
    }, 250);
    return () => window.clearTimeout(t);
  }, [query, root]);

  // group hits by file
  const grouped = hits.reduce<Record<string, SearchHit[]>>((acc, h) => {
    (acc[h.path] ??= []).push(h);
    return acc;
  }, {});

  return (
    <div className="search-panel">
      <input
        ref={inputRef}
        className="search-input"
        placeholder="search project…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
      />
      {error && <div className="panel-error">{error}</div>}
      <div className="search-results">
        {Object.entries(grouped).map(([path, fileHits]) => (
          <div key={path} className="search-group">
            <div className="search-file" title={path}>
              {path}
            </div>
            {fileHits.map((h, i) => (
              <button
                key={i}
                className="search-hit"
                onClick={() =>
                  onOpenView({
                    kind: "file",
                    key: `file:${root}/${path}`,
                    absPath: `${root}/${path}`,
                    line: h.line,
                  })
                }
              >
                <span className="search-line">{h.line}</span>
                <span className="search-text">{h.text}</span>
              </button>
            ))}
          </div>
        ))}
        {query.trim() && !error && hits.length === 0 && <div className="search-empty">no results</div>}
      </div>
    </div>
  );
}
