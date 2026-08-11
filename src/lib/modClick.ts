import { Decoration, DecorationSet, EditorView, ViewPlugin } from "@codemirror/view";
import { Extension, StateEffect, StateField } from "@codemirror/state";
import { findDefinition, looksResolvable, tokenAt } from "./goToDefinition";

/**
 * ⌘ over a name lights it up; ⌘-click opens where it's defined.
 *
 * The highlight is decided without touching the disk — see `looksResolvable`.
 * An affordance that arrived a round trip after the pointer would trail it,
 * and would flicker on every fast pass across a line.
 */

const setLink = StateEffect.define<{ from: number; to: number } | null>();

const linkMark = Decoration.mark({ class: "cm-mod-link" });

const linkField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setLink)) {
        deco = e.value ? Decoration.set([linkMark.range(e.value.from, e.value.to)]) : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** what's lit right now, so an unchanged hover doesn't dispatch every mousemove */
function current(view: EditorView): { from: number; to: number } | null {
  const set = view.state.field(linkField, false);
  if (!set) return null;
  const it = set.iter();
  return it.value ? { from: it.from, to: it.to } : null;
}

function light(view: EditorView, next: { from: number; to: number } | null) {
  const now = current(view);
  if (now?.from === next?.from && now?.to === next?.to) return;
  view.dispatch({ effects: setLink.of(next) });
}

function tokenUnder(view: EditorView, x: number, y: number) {
  const pos = view.posAtCoords({ x, y });
  if (pos === null) return null;
  const doc = view.state.doc.toString();
  const token = tokenAt(doc, pos);
  if (!token || !looksResolvable(doc, token)) return null;
  return token;
}

/**
 * @param absPath the file being edited, for resolving its relative imports
 */
export function modClick(absPath: () => string, onOpen: (abs: string, line?: number) => void): Extension {
  // where the pointer was last seen, so pressing ⌘ without moving still lights
  // the name underneath — which is how you'd naturally do it: settle, then press
  let mouse: { x: number; y: number } | null = null;

  return [
    linkField,
    EditorView.domEventHandlers({
      mousemove(event, view) {
        mouse = { x: event.clientX, y: event.clientY };
        light(view, event.metaKey ? tokenUnder(view, event.clientX, event.clientY) : null);
        return false;
      },
      mouseleave(_event, view) {
        mouse = null;
        light(view, null);
        return false;
      },
      // mousedown rather than click: the editor never gets to start a
      // selection under the pointer first
      mousedown(event, view) {
        if (!event.metaKey || event.button !== 0) return false;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) return false;
        const doc = view.state.doc.toString();
        const token = tokenAt(doc, pos);
        if (!token) return false;
        event.preventDefault();
        light(view, null);
        findDefinition(doc, absPath(), token)
          .then((def) => def && onOpen(def.abs, def.line))
          .catch(() => {});
        return true;
      },
    }),
    // ⌘ is pressed and released outside the editor's own DOM as often as
    // inside it, so the modifier is watched on the window
    ViewPlugin.define((view) => {
      const sync = (e: KeyboardEvent) => {
        if (e.key !== "Meta") return;
        light(view, e.type === "keydown" && mouse ? tokenUnder(view, mouse.x, mouse.y) : null);
      };
      const clear = () => light(view, null);
      window.addEventListener("keydown", sync);
      window.addEventListener("keyup", sync);
      // ⌘-tab away with the key still down and the highlight would be stuck on
      window.addEventListener("blur", clear);
      return {
        destroy() {
          window.removeEventListener("keydown", sync);
          window.removeEventListener("keyup", sync);
          window.removeEventListener("blur", clear);
        },
      };
    }),
  ];
}
