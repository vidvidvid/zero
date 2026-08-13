import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, DirEntry } from "../lib/api";
import { FileIconSpan } from "./FileIcon";
import { Chevron } from "./Chevron";
import { decorations, useGitStatus } from "../lib/gitStatus";
import type { View } from "./Workspace";

/** Audio goes to Finder rather than to the editor: QuickLook plays these with
 *  a space bar, and the editor would open a memo as a wall of bytes. */
const AUDIO = /\.(m4a|caf|wav|aiff|mp3)$/i;

/** a file to walk to and light up — ⌘E. The counter is what makes pressing it
    twice work: the path alone wouldn't have changed. */
export interface Reveal {
  path: string;
  n: number;
}

export function FileTree({
  root,
  active,
  reveal,
  onOpenView,
}: {
  root: string;
  active: boolean;
  reveal: Reveal | null;
  onOpenView: (v: View) => void;
}) {
  // expansion lives here rather than in each row: revealing a file means
  // opening every folder above it at once, which a row can't do to its parents
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [kids, setKids] = useState<Record<string, DirEntry[]>>({});
  const [selected, setSelected] = useState<string | null>(null);

  const kidsRef = useRef<Record<string, DirEntry[]>>({});
  const pending = useRef(new Map<string, Promise<DirEntry[]>>());
  const selRef = useRef<HTMLButtonElement | null>(null);
  const wantScroll = useRef(false);

  const git = useGitStatus(root, active);
  const marks = useMemo(() => {
    const wt = git.worktrees.find((w) => w.path === root) ?? git.worktrees.find((w) => w.is_main);
    return decorations(root, wt?.changes ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [git.epoch, root]);

  /** a directory's children, read once and remembered */
  const load = useCallback((dir: string): Promise<DirEntry[]> => {
    const have = kidsRef.current[dir];
    if (have) return Promise.resolve(have);
    let p = pending.current.get(dir);
    if (!p) {
      p = api
        .listDir(dir)
        .catch(() => [] as DirEntry[])
        .then((entries) => {
          kidsRef.current = { ...kidsRef.current, [dir]: entries };
          setKids(kidsRef.current);
          pending.current.delete(dir);
          return entries;
        });
      pending.current.set(dir, p);
    }
    return p;
  }, []);

  useEffect(() => {
    kidsRef.current = {};
    pending.current.clear();
    setKids({});
    setOpen(new Set());
    void load(root);
  }, [root, load]);

  useEffect(() => {
    if (!reveal) return;
    if (!reveal.path.startsWith(root + "/")) return;
    let cancelled = false;

    (async () => {
      const parts = reveal.path.slice(root.length + 1).split("/");
      const folders: string[] = [];
      let dir = root;
      for (let i = 0; i < parts.length - 1; i++) {
        dir = `${dir}/${parts[i]}`;
        folders.push(dir);
      }
      // one level at a time: a folder's children are how the next level down
      // is reached, so they have to have arrived before we ask for it
      await load(root);
      for (const f of folders) {
        if (cancelled) return;
        await load(f);
      }
      if (cancelled) return;
      setOpen((prev) => {
        const next = new Set(prev);
        folders.forEach((f) => next.add(f));
        return next;
      });
      setSelected(reveal.path);
      wantScroll.current = true;
    })();

    return () => {
      cancelled = true;
    };
  }, [reveal, root, load]);

  // after the folders have opened and the row exists
  useEffect(() => {
    if (wantScroll.current && selRef.current) {
      selRef.current.scrollIntoView({ block: "nearest" });
      wantScroll.current = false;
    }
  });

  const toggle = (dir: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        void load(dir);
      }
      return next;
    });

  const rows = (dir: string, depth: number): ReactNode[] =>
    (kids[dir] ?? []).flatMap((entry) => {
      const full = `${dir}/${entry.name}`;
      const isSel = selected === full;
      const pad = { paddingLeft: depth * 14 + 8 };

      if (!entry.is_dir) {
        const mark = marks.files.get(full);
        return [
          <button
            key={full}
            ref={isSel ? selRef : undefined}
            className={`tree-item file ${entry.ignored ? "ignored" : ""} ${
              isSel ? "selected" : ""
            } ${mark ? `git-${mark.mark}` : ""}`}
            style={pad}
            onClick={() => {
              setSelected(full);
              // audio goes to Finder, where QuickLook plays it with a space
              // bar; the editor would open a memo as a wall of bytes
              if (AUDIO.test(entry.name)) {
                api.revealPath(full).catch(() => {});
                return;
              }
              onOpenView({ kind: "file", key: `file:${full}`, absPath: full });
            }}
          >
            <FileIconSpan name={entry.name} />
            <span className="tree-name">{entry.name}</span>
            {mark && <span className="tree-badge">{mark.letter}</span>}
          </button>,
        ];
      }

      const isOpen = open.has(full);
      const dirMark = marks.dirs.get(full);
      return [
        <button
          key={full}
          className={`tree-item dir ${entry.ignored ? "ignored" : ""} ${
            dirMark ? `git-${dirMark}` : ""
          }`}
          style={pad}
          onClick={() => toggle(full)}
        >
          <Chevron open={isOpen} className="tree-arrow" />
          <span className="tree-name">{entry.name}</span>
        </button>,
        ...(isOpen ? rows(full, depth + 1) : []),
      ];
    });

  return <div className="file-tree">{rows(root, 0)}</div>;
}
