/**
 * "Something on disk just changed, and it was us."
 *
 * The file tree reads a folder once and remembers it — which is right, since
 * nothing walks the project on a timer — and that cache is exactly what a
 * rename from somewhere else in the app leaves stale. There is no watcher to
 * lean on and no need for one: every write the app makes goes through the menu
 * actions, so the app already knows the moment it happens.
 *
 * A folder, not a file: what changed is which entries a directory has. `null`
 * means "no idea, re-read everything", which is what a move between folders
 * would need if there were ever one.
 *
 * The same shape as `pokeGit` in gitStatus, and for the same reason — the pair
 * of them is what a mutation calls on its way out.
 */

const listeners = new Set<(dir: string | null) => void>();

export function pokeFiles(dir: string | null = null) {
  listeners.forEach((fn) => fn(dir));
}

export function onFilesChanged(fn: (dir: string | null) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * A path stopped being where it was — renamed to `to`, or gone if that's null.
 *
 * Separate from the folder poke above because it has a different audience: the
 * tree wants to know a folder's contents changed, and the *editor* wants to
 * know that a tab it is holding open now points at nothing. Renaming a file
 * you have open is an ordinary thing to do, and a tab left pointing at the old
 * name is the kind of stale that only shows up as a failed read later.
 */
const moved = new Set<(from: string, to: string | null) => void>();

export function pokeMoved(from: string, to: string | null) {
  moved.forEach((fn) => fn(from, to));
}

export function onPathMoved(fn: (from: string, to: string | null) => void): () => void {
  moved.add(fn);
  return () => {
    moved.delete(fn);
  };
}

/** `from` itself, or something inside it when it's a folder — what a rename of
 *  a directory has to rewrite as well as the directory's own name */
export const under = (path: string, from: string) =>
  path === from || path.startsWith(from + "/");

/** the folder an entry sits in — what to poke after making or unmaking it */
export const parentOf = (path: string) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
