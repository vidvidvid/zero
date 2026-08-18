import { useEffect, useRef } from "react";
import { getChunks, MergeView } from "@codemirror/merge";
import { basicSetup } from "codemirror";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { editorTheme } from "../lib/cmTheme";
import { charDiff } from "../lib/diffChars";
import { lineDiff } from "../lib/lineDiff";
import { api } from "../lib/api";
import { langFor, lazyLangFor } from "../lib/lang";
import { diffRuler } from "../lib/scrollRuler";
import { pokeGit } from "../lib/gitStatus";

/**
 * One of git's two diffs, and which one is the whole point of `staged`.
 *
 * A row under "changes" is the working tree against the *index*, not against
 * HEAD: stage half a file, edit it again, and a diff against HEAD would show
 * the staged half over again as though it were still to do. A row under
 * "staged" is the other half — HEAD against the index, which is exactly what
 * committing now would record, and read-only because the index isn't a file
 * you can type into.
 */
export function DiffView({
  worktree,
  relPath,
  staged = false,
  visible,
}: {
  worktree: string;
  relPath: string;
  staged?: boolean;
  visible: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const loadedRef = useRef<{ a: string; b: string }>({ a: "", b: "" });
  const dirtyRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    let disposed = false;
    const absPath = `${worktree}/${relPath}`;
    // one compartment per side: a compartment holds one value per state, and
    // the two sides are two states
    const langA = new Compartment();
    const langB = new Compartment();
    const langLater = lazyLangFor(relPath);

    const load = async () => {
      const [a, b] = await Promise.all([
        staged ? api.headFile(worktree, relPath) : api.indexFile(worktree, relPath),
        staged
          ? api.indexFile(worktree, relPath)
          : api.readFile(absPath).catch(() => ""), // deleted files
      ]);
      return { a, b };
    };

    const save = (view: EditorView) => {
      const text = view.state.doc.toString();
      api.writeFile(absPath, text).then(() => {
        dirtyRef.current = false;
        loadedRef.current = { ...loadedRef.current, b: text };
        pokeGit();
      });
      return true;
    };

    load().then((docs) => {
      if (disposed || !hostRef.current) return;
      loadedRef.current = docs;
      dirtyRef.current = false;
      mergeRef.current = new MergeView({
        parent: hostRef.current,
        a: {
          doc: docs.a,
          extensions: [
            lineNumbers(),
            EditorView.editable.of(false),
            EditorState.readOnly.of(true),
            EditorView.lineWrapping,
            editorTheme(),
            charDiff(() => mergeRef.current?.b.state.doc ?? null),
            langA.of(langFor(relPath)),
          ],
        },
        b: {
          doc: docs.b,
          extensions: [
            basicSetup,
            EditorView.lineWrapping,
            editorTheme(),
            diffRuler(),
            charDiff(() => mergeRef.current?.a.state.doc ?? null),
            langB.of(langFor(relPath)),
            ...(staged
              ? [EditorView.editable.of(false), EditorState.readOnly.of(true)]
              : [
                  EditorView.updateListener.of((u) => {
                    if (u.docChanged) dirtyRef.current = true;
                    // a chunk revert is a deliberate act on the file, not
                    // typing — persist it now rather than waiting for ⌘S
                    if (u.transactions.some((tr) => tr.isUserEvent("revert"))) save(u.view);
                  }),
                  keymap.of([indentWithTab, { key: "Mod-s", run: save }]),
                ]),
          ],
        },
        gutter: true,
        // stock char highlighting paints whole added lines and grows changes
        // to word boundaries; charDiff above replaces it with VS Code's read
        highlightChanges: false,
        // the per-chunk arrow, Cursor style — pull the old side back over the
        // working tree. Meaningless on a staged diff, whose B side is the
        // index, not a file
        revertControls: staged ? undefined : "a-to-b",
        // the whole file, no collapsed bands — Cursor's way: everything is
        // there to scroll, and where you land is the first change
        //
        // and diff by lines, the way git does — see lineDiff.ts for what the
        // stock character diff does to a file with more than a few changes
        diffConfig: { override: lineDiff },
      });

      // the charDiff plugins were built while mergeRef was still null and
      // couldn't see across; now both sides exist, have them look again
      mergeRef.current.a.dispatch({});
      mergeRef.current.b.dispatch({});

      const first = getChunks(mergeRef.current.b.state)?.chunks[0];
      if (first) {
        mergeRef.current.b.dispatch({
          effects: EditorView.scrollIntoView(first.fromB, { y: "center" }),
        });
      }

      langLater.then((ext) => {
        if (disposed || !ext || !mergeRef.current) return;
        mergeRef.current.a.dispatch({ effects: langA.reconfigure(ext) });
        mergeRef.current.b.dispatch({ effects: langB.reconfigure(ext) });
      });
    });

    // live refresh: Claude Code edits files while we watch. Background tabs
    // skip it — every tick is two file reads over IPC on the main thread, and
    // a dozen open tabs doing that is a hitch you can feel while scrolling.
    const iv = window.setInterval(async () => {
      if (!mergeRef.current || document.hidden || !visibleRef.current) return;
      const docs = await load();
      if (disposed || !mergeRef.current) return;
      const mv = mergeRef.current;
      if (docs.a !== loadedRef.current.a) {
        mv.a.dispatch({ changes: minimalChange(loadedRef.current.a, docs.a) });
        loadedRef.current = { ...loadedRef.current, a: docs.a };
      }
      // never clobber unsaved edits on the working-tree side
      if (!dirtyRef.current && docs.b !== loadedRef.current.b) {
        mv.b.dispatch({ changes: minimalChange(loadedRef.current.b, docs.b) });
        dirtyRef.current = false;
        loadedRef.current = { ...loadedRef.current, b: docs.b };
      }
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(iv);
      mergeRef.current?.destroy();
      mergeRef.current = null;
    };
  }, [worktree, relPath, staged]);

  return <div className="cm-host" ref={hostRef} />;
}

/**
 * The smallest change that turns `old` into `next`: trim what the two share at
 * each end and replace the rest.
 *
 * Handing CodeMirror the whole document instead — which is what this did —
 * says every character changed, and everything downstream believes it. The
 * merge view re-diffs the file end to end, the parser drops the syntax tree
 * and reparses, the highlighter repaints, and the cursor and scroll position
 * have nothing to be mapped through. All of it every two seconds, because an
 * agent touched one line.
 */
function minimalChange(old: string, next: string) {
  const max = Math.min(old.length, next.length);
  let head = 0;
  while (head < max && old.charCodeAt(head) === next.charCodeAt(head)) head++;
  let tail = 0;
  while (
    tail < max - head &&
    old.charCodeAt(old.length - tail - 1) === next.charCodeAt(next.length - tail - 1)
  )
    tail++;
  // a surrogate pair is one character in two units; cutting between them would
  // leave a lone half in the document
  if (head > 0 && (old.charCodeAt(head - 1) & 0xfc00) === 0xd800) head--;
  if (tail > 0 && (old.charCodeAt(old.length - tail) & 0xfc00) === 0xdc00) tail--;
  return { from: head, to: old.length - tail, insert: next.slice(head, next.length - tail) };
}
