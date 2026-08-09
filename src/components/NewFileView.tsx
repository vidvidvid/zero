import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { save } from "@tauri-apps/plugin-dialog";
import { darkModern } from "../lib/cmTheme";
import { api } from "../lib/api";

/**
 * An untitled buffer, like ⌘N in Cursor: nothing exists on disk until ⌘S,
 * which asks where to put it and then hands the path back so the tab can
 * become a normal file view.
 */
export function NewFileView({ root, onSaved }: { root: string; onSaved: (absPath: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      doc: "",
      extensions: [
        basicSetup,
        darkModern,
        EditorView.lineWrapping,
        keymap.of([
          indentWithTab,
          {
            key: "Mod-s",
            run: (v) => {
              save({ defaultPath: root, title: "Save file" }).then((path) => {
                if (!path) return;
                api.writeFile(path, v.state.doc.toString()).then(() => savedRef.current(path));
              });
              return true;
            },
          },
        ]),
      ],
    });
    view.focus();
    return () => view.destroy();
  }, [root]);

  return <div className="cm-host" ref={hostRef} />;
}
