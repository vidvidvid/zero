import { useEffect, useState } from "react";

/**
 * The language picker's question half, shaped like lib/prompt and for the same
 * reason: the thing that asks is a native menu action — a callback with no
 * place in the tree — so the pending question lives here and the overlay
 * (components/LanguagePick) renders whatever is current.
 */

export interface LangAsk {
  /** the file whose kind is being decided, for the overlay to name */
  fileName: string;
  /** the answer in force: a language name, lang.ts's PLAIN, or null for
   *  "whatever the tables say" — so the list can mark it */
  current: string | null;
}

interface Pending extends LangAsk {
  /** counts up per question, so the overlay can reset its filter between two
   *  asks rather than showing the last one's leftovers */
  id: number;
  done: (choice: string | null) => void;
}

let asked = 0;
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** Resolves with a language name, "auto", lang.ts's PLAIN, or null if the
 *  overlay was dismissed. "auto" can't collide with a language: registry
 *  names are capitalised, and the row is matched by identity anyway. */
export function pickLanguage(a: LangAsk): Promise<string | null> {
  // same one-liner as prompt.ts: a dropped promise is a caller waiting forever
  pending?.done(null);
  return new Promise((resolve) => {
    pending = {
      ...a,
      id: ++asked,
      done: (choice) => {
        pending = null;
        emit();
        resolve(choice);
      },
    };
    emit();
  });
}

export function useLangPick(): Pending | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const onChange = () => bump((n) => n + 1);
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);
  return pending;
}
