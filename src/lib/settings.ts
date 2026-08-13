import { useSyncExternalStore } from "react";

/**
 * App-wide settings, as opposed to per-project layout (that's session.ts).
 *
 * Same storage decision as the session for the same reason: localStorage reads
 * synchronously, so the very first editor an opened project mounts can be in
 * the right theme instead of flashing the default and correcting itself.
 */

const KEY = "zero-settings";

export const EDITOR_THEMES = ["dark-modern", "trmnl"] as const;
export type EditorTheme = (typeof EDITOR_THEMES)[number];

export interface Settings {
  editorTheme: EditorTheme;
}

const DEFAULTS: Settings = {
  editorTheme: "dark-modern",
};

// The stored blob survives across versions of zero, so anything unrecognised
// falls back to the default rather than being trusted.
function parse(raw: string | null): Settings {
  if (!raw) return { ...DEFAULTS };
  let blob: Partial<Settings>;
  try {
    blob = JSON.parse(raw) as Partial<Settings>;
  } catch {
    return { ...DEFAULTS };
  }
  return {
    editorTheme: EDITOR_THEMES.includes(blob.editorTheme as EditorTheme)
      ? (blob.editorTheme as EditorTheme)
      : DEFAULTS.editorTheme,
  };
}

let current: Settings = parse(localStorage.getItem(KEY));

const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // a full or disabled store costs you persistence, not the change itself
  }
  for (const fn of listeners) fn();
}

/** Subscribe to changes; returns the unsubscribe. Used by non-React consumers
 *  (live editor views) as well as the hook below. */
export function onSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSettings(): Settings {
  return useSyncExternalStore(onSettingsChange, getSettings);
}
