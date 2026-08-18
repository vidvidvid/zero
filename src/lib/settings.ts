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

export const APPEARANCES = ["light", "dark", "system"] as const;
export type Appearance = (typeof APPEARANCES)[number];

export interface Settings {
  editorTheme: EditorTheme;
  /** Liquid Glass behind every surface (macOS 26+). Off means solid — the
   *  app exactly as it looks where glass doesn't exist. */
  glass: boolean;
  /** light / dark, or system to follow macOS. What most consumers want is
   *  not this but `resolvedAppearance()` — the two-value answer. */
  appearance: Appearance;
  /** the user's language choices: extension (or whole filename when there is
   *  no extension) → registry language name. lang.ts owns what the keys and
   *  values mean; this is only where they sleep. */
  langOverrides: Record<string, string>;
}

const DEFAULTS: Settings = {
  editorTheme: "dark-modern",
  glass: true,
  appearance: "system",
  langOverrides: {},
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
    glass: typeof blob.glass === "boolean" ? blob.glass : DEFAULTS.glass,
    appearance: APPEARANCES.includes(blob.appearance as Appearance)
      ? (blob.appearance as Appearance)
      : DEFAULTS.appearance,
    langOverrides: sanitizeOverrides(blob.langOverrides),
  };
}

function sanitizeOverrides(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(v)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
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

/** The two-value answer every renderer wants: `system` resolved against what
 *  macOS currently says. Subscribers to the store hear OS flips too — the
 *  media-query listener below refires them, and it rebuilds `current` so the
 *  React snapshot changes identity even though no stored value moved. */
export function resolvedAppearance(): "light" | "dark" {
  const a = current.appearance;
  if (a !== "system") return a;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (current.appearance !== "system") return;
  current = { ...current };
  for (const fn of listeners) fn();
});
