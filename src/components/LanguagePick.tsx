import { useEffect, useMemo, useRef, useState } from "react";
import { useLangPick } from "../lib/langPick";
import { matchedIndices, rankPaths } from "../lib/fuzzy";
import { languageNames, PLAIN } from "../lib/lang";
import { marked } from "./QuickOpen";

/** The two answers that aren't languages, pinned above the alphabet: back to
 *  the tables, and no colouring at all. */
const AUTO_ROW = "Automatic";
const PLAIN_ROW = "Plain Text";

/**
 * The overlay half of `lib/langPick` — mounted once, empty until a tab's menu
 * asks. Quick open's clothes on prompt's skeleton: the same backdrop, box and
 * list, filtered by the same fuzzy ranking, resolving a promise a native menu
 * action is waiting on.
 */
export function LanguagePick() {
  const pending = useLangPick();
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // a fresh question starts with a fresh filter
  const id = pending?.id;
  useEffect(() => {
    setQuery("");
    setAt(0);
    inputRef.current?.focus();
  }, [id]);

  const rows = useMemo(() => [AUTO_ROW, PLAIN_ROW, ...languageNames()], []);
  const results = useMemo(() => rankPaths(rows, query, 50), [rows, query]);

  useEffect(() => setAt(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector(".quick-item.on")?.scrollIntoView({ block: "nearest" });
  }, [at, results]);

  if (!pending) return null;

  const markOn =
    pending.current === null ? AUTO_ROW : pending.current === PLAIN ? PLAIN_ROW : pending.current;
  const choose = (row: string) =>
    pending.done(row === AUTO_ROW ? "auto" : row === PLAIN_ROW ? PLAIN : row);

  const onKey = (e: React.KeyboardEvent) => {
    // every key in here is this field's — see Prompt for the ⌘W story
    e.stopPropagation();
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key.toLowerCase() === "n")) {
      e.preventDefault();
      setAt((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key.toLowerCase() === "p")) {
      e.preventDefault();
      setAt((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[at]) choose(results[at].path);
    } else if (e.key === "Escape") {
      e.preventDefault();
      pending.done(null);
    }
  };

  return (
    <div className="quick-backdrop" onMouseDown={() => pending.done(null)}>
      <div className="quick-box" onMouseDown={(e) => e.stopPropagation()}>
        <input
          key={pending.id}
          ref={inputRef}
          className="quick-input"
          placeholder={`language for ${pending.fileName}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          autoFocus
        />
        <div className="quick-list" ref={listRef}>
          {results.map((r, i) => (
            <button
              key={r.path}
              className={`quick-item ${i === at ? "on" : ""}`}
              onMouseMove={() => setAt(i)}
              onClick={() => choose(r.path)}
            >
              <span className="quick-name">{marked(r.path, 0, matchedIndices(r.path, query))}</span>
              {r.path === markOn && <span className="quick-dir">current</span>}
            </button>
          ))}
          {results.length === 0 && <div className="quick-empty">no matching language</div>}
        </div>
      </div>
    </div>
  );
}
