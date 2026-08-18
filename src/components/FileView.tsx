import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { Compartment, Text } from "@codemirror/state";
import { editorTheme } from "../lib/cmTheme";
import { api } from "../lib/api";
import { langFor, lazyLangFor, lazyLangForShebang } from "../lib/lang";
import { modClick } from "../lib/modClick";
import { changeGutter, setBaseline } from "../lib/changeGutter";
import { pokeGit } from "../lib/gitStatus";

export function FileView({
  absPath,
  line,
  visible,
  onOpenFile,
}: {
  absPath: string;
  line?: number;
  visible: boolean;
  /** ⌘-click resolved to a definition somewhere */
  onOpenFile: (abs: string, line?: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const dirtyRef = useRef(false);
  const lastLoadedRef = useRef("");
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // the editor is built once per file; the callback is new every render
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  useEffect(() => {
    let disposed = false;
    // the language sits in a compartment so a mode that has to be fetched can
    // drop in later without rebuilding the editor under the cursor
    const lang = new Compartment();
    // started now, applied after the view exists — the two races otherwise
    const langLater = lazyLangFor(absPath);

    // what the change bars are measured against. Re-read on a timer as well as
    // at open, because HEAD moves under us: a commit in the terminal should
    // clear the bars for what it just committed.
    const readBaseline = async () => {
      const b = await api.gitBaseline(absPath).catch(() => null);
      if (disposed || !viewRef.current) return;
      viewRef.current.dispatch({
        effects: setBaseline.of(b?.tracked ? Text.of(b.content.split("\n")) : null),
      });
    };

    api.readFile(absPath).then((content) => {
      if (disposed || !hostRef.current) return;
      lastLoadedRef.current = content;
      viewRef.current = new EditorView({
        parent: hostRef.current,
        doc: content,
        extensions: [
          basicSetup,
          editorTheme(),
          EditorView.lineWrapping,
          changeGutter(),
          lang.of(langFor(absPath)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) dirtyRef.current = true;
          }),
          modClick(
            () => absPath,
            (abs, ln) => onOpenFileRef.current(abs, ln)
          ),
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
                  // the file just changed on disk, so the panel is wrong until
                  // it looks again — this is the one moment we know that
                  pokeGit();
                });
                return true;
              },
            },
          ]),
        ],
      });
      if (line) jumpToLine(viewRef.current, line);
      void readBaseline();

      langLater.then(async (ext) => {
        // a name that said nothing might still open with #!/bin/bash
        const mode =
          ext ?? (langFor(absPath).length ? null : await lazyLangForShebang(content));
        if (disposed || !mode || !viewRef.current) return;
        viewRef.current.dispatch({ effects: lang.reconfigure(mode) });
      });
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

    const baselineIv = window.setInterval(() => {
      if (!viewRef.current || document.hidden || !visibleRef.current) return;
      void readBaseline();
    }, 5000);

    return () => {
      disposed = true;
      window.clearInterval(iv);
      window.clearInterval(baselineIv);
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
