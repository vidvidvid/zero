/**
 * Disclosure triangle. Two drawn shapes rather than one rotated shape — the
 * way VS Code and Cursor do it. A rotating triangle reads as travelling
 * because its mass sits off the axis it spins around, however the box is
 * aligned; swapping avoids the problem instead of balancing it.
 *
 * Both paths are the same triangle 90° apart, each centred on (6,6).
 */
const RIGHT = "M4 2.5 L8 6 L4 9.5 Z";
const DOWN = "M2.5 4 L9.5 4 L6 8 Z";

export function Chevron({ open, className = "" }: { open: boolean; className?: string }) {
  return (
    <span className={`chevron ${open ? "open" : ""} ${className}`}>
      <svg width="11" height="11" viewBox="0 0 12 12">
        <path d={open ? DOWN : RIGHT} fill="currentColor" />
      </svg>
    </span>
  );
}
