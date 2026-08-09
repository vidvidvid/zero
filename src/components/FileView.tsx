import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { darkModern } from "../lib/cmTheme";
import { api } from "../lib/api";
import { langFor } from "../lib/lang";

export function FileView({
  absPath,
  line,
  visible,
}: {
  absPath: string;
  line?: number;
  visible: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const dirtyRef = useRef(false);
  const lastLoadedRef = useRef("");
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    let disposed = false;

    api.readFile(absPath).then((content) => {
      if (disposed || !hostRef.current) return;
      lastLoadedRef.current = content;
      viewRef.current = new EditorView({
        parent: hostRef.current,
        doc: content,
        extensions: [
          basicSetup,
          darkModern,
          EditorView.lineWrapping,
          ...langFor(absPath),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) dirtyRef.current = true;
          }),
          // basicSetup deliberately leaves Tab for focus traversal; in an
          // editor you want it indenting, like Cursor
          keymap.of([
            indentWithTab,
            {
              key: "Mod-s",
              run: (view) => {
                const text = view.state.doc.toString();
                api.writeFile(absPath, text).then(() => {
                  dirtyRef.current = false;
                  lastLoadedRef.current = text;
                });
                return true;
              },
            },
          ]),
        ],
      });
      if (line) jumpToLine(viewRef.current, line);
    });

    // live refresh unless the user has unsaved edits — and never for a tab
    // that isn't on screen
    const iv = window.setInterval(async () => {
      if (!viewRef.current || dirtyRef.current || document.hidden || !visibleRef.current) return;
      const content = await api.readFile(absPath).catch(() => null);
      if (disposed || content === null || !viewRef.current) return;
      if (content !== lastLoadedRef.current) {
        lastLoadedRef.current = content;
        dirtyRef.current = false;
        viewRef.current.dispatch({
          changes: { from: 0, to: viewRef.current.state.doc.length, insert: content },
        });
      }
    }, 2000);

    return () => {
      disposed = true;
      window.clearInterval(iv);
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [absPath]);

  // search jump on an already-open file
  useEffect(() => {
    if (line && viewRef.current) jumpToLine(viewRef.current, line);
  }, [line]);

  return <div className="cm-host" ref={hostRef} />;
}

function jumpToLine(view: EditorView, line: number) {
  const ln = Math.min(line, view.state.doc.lines);
  const pos = view.state.doc.line(ln).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  view.focus();
}
