import { useEffect } from "react";
import { EDITOR_THEME_CHOICES } from "../lib/cmTheme";
import { updateSettings, useSettings } from "../lib/settings";

/**
 * App settings, ⌘, — one overlay for the whole app, not per project. There is
 * exactly one setting so far; the shape is a labelled group per setting so the
 * next one is an append, not a redesign.
 *
 * Picking a theme applies it on the spot: every open editor follows the
 * settings store live, so the code behind the overlay is the preview.
 */
export function Settings({ onClose }: { onClose: () => void }) {
  const settings = useSettings();

  // capture phase: while the overlay is up it is the topmost layer, and ⎋
  // belongs to it — not to quick open under it, not to a memo recording
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  return (
    <div className="quick-backdrop" onMouseDown={onClose}>
      <div className="settings-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title">settings</div>
        <div className="settings-group">
          <div className="settings-label">syntax theme</div>
          {EDITOR_THEME_CHOICES.map((c) => {
            const on = settings.editorTheme === c.id;
            return (
              <button
                key={c.id}
                className={`settings-choice ${on ? "on" : ""}`}
                onClick={() => updateSettings({ editorTheme: c.id })}
              >
                <span className="settings-dot" aria-hidden />
                <span className="settings-choice-name">{c.label}</span>
                <span className="settings-swatch" aria-hidden>
                  {c.swatch.map((color) => (
                    <i key={color} style={{ background: color }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
