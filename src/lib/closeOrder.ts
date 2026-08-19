/**
 * One order across two stacks.
 *
 * ⌘⇧T undoes the most recent close, and "most recent" has to be comparable
 * across kinds: a closed tab is remembered by the workspace that held it, a
 * closed project by the app above them, and neither stack can see the other's
 * history. A number both stamp their entries with is the whole of what they
 * need to share — cheaper than hoisting one stack into the other, and it keeps
 * each kind's reopening where the state it restores already lives.
 *
 * A counter rather than a clock: two closes inside the same millisecond are an
 * ordinary run of ⌘W, and `Date.now()` would call them a tie.
 */
let seq = 0;

export function closeSeq(): number {
  return ++seq;
}
