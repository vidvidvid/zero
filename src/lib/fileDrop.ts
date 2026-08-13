import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./api";

// Files dragged in from Finder never reach the terminal on their own. Tauri
// takes the OS drag before the webview sees it — that's `dragDropEnabled`,
// which is on by default — so no HTML drop event fires anywhere in the page
// and xterm's textarea, which would otherwise paste what it was given, hears
// nothing. The paths arrive here instead, on the webview's own event, and this
// is what puts them in the pane they were aimed at.

/** Everything outside this set gets a backslash, which is the escaping a
 *  terminal does when you drop a file on it. One path with spaces in it stays
 *  one argument, to a shell and to Claude Code alike. */
const NEEDS_ESCAPE = /[^A-Za-z0-9_+=:,.@%/-]/g;

function escapePath(path: string): string {
  return path.replace(NEEDS_ESCAPE, "\\$&");
}

/** the terminal pane under a screen point, if the point is over one at all */
function paneAt(pos: { x: number; y: number }): HTMLElement | null {
  // the event carries physical pixels and elementFromPoint wants CSS ones.
  // devicePixelRatio is the whole conversion: it holds the display's scale and
  // the UI zoom together, because WebKit folds page zoom into it — and the app
  // zooms the page natively (see App.tsx), so a fixed scale factor would miss
  // the pane by the zoom factor at anything other than 100%.
  const scale = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(pos.x / scale, pos.y / scale);
  return el?.closest<HTMLElement>("[data-term-id]") ?? null;
}

/** the pane currently lit up as the drop target */
let hovered: HTMLElement | null = null;

function highlight(pane: HTMLElement | null) {
  if (pane === hovered) return;
  hovered?.classList.remove("term-drop");
  pane?.classList.add("term-drop");
  hovered = pane;
}

let started = false;

/** Idempotent, and never torn down: one listener serves every pane in every
 *  project, since it finds its target in the DOM rather than being told. */
export function watchFileDrops() {
  if (started) return;
  started = true;
  getCurrentWebview()
    .onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        highlight(null);
        return;
      }
      const pane = paneAt(payload.position);
      if (payload.type !== "drop") {
        // lighting the pane as it's dragged over says where the path will go,
        // which is the only feedback there is before letting go
        highlight(pane);
        return;
      }
      highlight(null);
      const id = pane?.dataset.termId;
      if (!id || payload.paths.length === 0) return;
      // trailing space so a second file, or whatever gets typed next, doesn't
      // run into the path
      const text = payload.paths.map(escapePath).join(" ") + " ";
      api.ptyWrite(id, text).catch((e) => console.warn(`drop: ${e}`));
      // the drop is where you were looking, so put the caret there too
      pane.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
    })
    .catch((e) => console.warn(`drop: ${e}`));
}
