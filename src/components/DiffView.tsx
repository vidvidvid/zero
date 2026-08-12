import { useEffect, useRef } from "react";
import { MergeView } from "@codemirror/merge";
import { basicSetup } from "codemirror";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { darkModern } from "../lib/cmTheme";
import { api } from "../lib/api";
import { langFor, lazyLangFor } from "../lib/lang";

export function DiffView({
  worktree,
  relPath,
  visible,
}: {
  worktree: string;
  relPath: string;
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
      const [head, current] = await Promise.all([
        api.headFile(worktree, relPath),
        api.readFile(absPath).catch(() => ""), // deleted files
      ]);
      return { a: head, b: current };
    };

    const save = (view: EditorView) => {
      const text = view.state.doc.toString();
      api.writeFile(absPath, text).then(() => {
        dirtyRef.current = false;
        loadedRef.current = { ...loadedRef.current, b: text };
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
            darkModern,
            langA.of(langFor(relPath)),
          ],
        },
        b: {
          doc: docs.b,
          extensions: [
            basicSetup,
            EditorView.lineWrapping,
            darkModern,
            langB.of(langFor(relPath)),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) dirtyRef.current = true;
            }),
            keymap.of([indentWithTab, { key: "Mod-s", run: save }]),
          ],
        },
        gutter: true,
        // show only the edited regions, VS Code style: 3 lines of context,
        // longer unchanged stretches become a click-to-expand band
        collapseUnchanged: { margin: 3, minSize: 4 },
      });

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
        mv.a.dispatch({ changes: { from: 0, to: mv.a.state.doc.length, insert: docs.a } });
        loadedRef.current = { ...loadedRef.current, a: docs.a };
      }
      // never clobber unsaved edits on the working-tree side
      if (!dirtyRef.current && docs.b !== loadedRef.current.b) {
        mv.b.dispatch({ changes: { from: 0, to: mv.b.state.doc.length, insert: docs.b } });
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
  }, [worktree, relPath]);

  return <div className="cm-host" ref={hostRef} />;
}
