import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, DirEntry } from "../lib/api";
import { contextMenu, fileEntries } from "../lib/contextMenu";
import { onFilesChanged } from "../lib/fileEvents";
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

  /**
   * A folder was written to — forget what we knew of it and ask again.
   *
   * The tree reads a directory once and remembers, which is what keeps it from
   * walking the project on a timer; the cost is that a rename from anywhere
   * else in the app leaves a row saying the old name. `null` is "no idea
   * which", and drops the lot — every open folder then reloads as it is drawn.
   */
  useEffect(
    () =>
      onFilesChanged((dir) => {
        if (dir === null) {
          kidsRef.current = {};
          pending.current.clear();
          setKids({});
          void load(root);
          return;
        }
        if (!(dir in kidsRef.current)) return;
        const next = { ...kidsRef.current };
        delete next[dir];
        // the ref only — `kids` keeps the old rows until the new ones arrive,
        // which is a folder that doesn't blink every time you rename in it
        kidsRef.current = next;
        pending.current.delete(dir);
        void load(dir);
      }),
    [root, load]
  );

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

  /** what a click on a file row does, and what the menu's "Open" does too */
  const openFile = (full: string, name = full.slice(full.lastIndexOf("/") + 1)) => {
    setSelected(full);
    // audio goes to Finder, where QuickLook plays it with a space bar; the
    // editor would open a memo as a wall of bytes
    if (AUDIO.test(name)) {
      api.revealPath(full).catch(() => {});
      return;
    }
    onOpenView({ kind: "file", key: `file:${full}`, absPath: full });
  };

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
            onClick={() => openFile(full, entry.name)}
            // the row the menu is about lights up while it's open, the way a
            // right-click in Finder selects what it landed on
            onContextMenu={(e) => {
              setSelected(full);
              contextMenu(e, [
                { text: "Open", run: () => openFile(full, entry.name) },
                ...fileEntries(full, { root, after: (made) => openFile(made) }),
              ]);
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
          onContextMenu={(e) =>
            contextMenu(e, [
              // a new file lands in the folder you asked from, so open it —
              // otherwise the row appears under a chevron still pointing right
              ...fileEntries(full, {
                root,
                isDir: true,
                after: (made) => {
                  // the same pair `toggle` does: opening a folder and reading
                  // it are two things, and a folder nobody had opened yet has
                  // no children loaded for the new row to appear among
                  setOpen((prev) => (prev.has(full) ? prev : new Set(prev).add(full)));
                  void load(full);
                  openFile(made);
                },
              }),
            ])
          }
        >
          <Chevron open={isOpen} className="tree-arrow" />
          <span className="tree-name">{entry.name}</span>
        </button>,
        ...(isOpen ? rows(full, depth + 1) : []),
      ];
    });

  // The container's own menu, which only ever fires on the space below the last
  // row — every row stops the event. That space is the project itself, so what
  // it offers is what you can put *in* the project: the root is not one of the
  // project's entries and has no business being renamed or trashed from here.
  return (
    <div
      className="file-tree"
      onContextMenu={(e) =>
        contextMenu(e, [
          ...fileEntries(root, { root, isDir: true, writes: "inside", after: openFile }),
        ])
      }
    >
      {rows(root, 0)}
    </div>
  );
}
