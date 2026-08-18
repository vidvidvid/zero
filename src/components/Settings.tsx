import { useEffect } from "react";
import { EDITOR_THEME_CHOICES } from "../lib/cmTheme";
import { updateSettings, useSettings } from "../lib/settings";

/**
 * App settings, ⌘, — one overlay for the whole app, not per project. The
 * shape is a labelled group per setting so the next one is an append, not a
 * redesign.
 *
 * Picking anything applies it on the spot: every open editor follows the
 * settings store live, and the window itself re-glasses under the overlay,
 * so the app behind the overlay is the preview.
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
        <div className="settings-title">preferences</div>
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
        <div className="settings-group">
          <div className="settings-label">appearance</div>
          {(["light", "dark", "system"] as const).map((a) => {
            const on = settings.appearance === a;
            return (
              <button
                key={a}
                className={`settings-choice ${on ? "on" : ""}`}
                onClick={() => updateSettings({ appearance: a })}
              >
                <span className="settings-dot" aria-hidden />
                <span className="settings-choice-name">{a}</span>
              </button>
            );
          })}
        </div>
        <div className="settings-group">
          <div className="settings-label">window</div>
          {(
            [
              { id: true, label: "liquid glass" },
              { id: false, label: "solid" },
            ] as const
          ).map((c) => {
            const on = settings.glass === c.id;
            return (
              <button
                key={c.label}
                className={`settings-choice ${on ? "on" : ""}`}
                onClick={() => updateSettings({ glass: c.id })}
              >
                <span className="settings-dot" aria-hidden />
                <span className="settings-choice-name">{c.label}</span>
              </button>
            );
          })}
        </div>
        <div className="settings-group">
          <div className="settings-label">terminal</div>
          {/* the one panel that can take its chrome off — see settings.ts for
              why this isn't offered per panel */}
          {(
            [
              { id: "panel", label: "panel" },
              { id: "plain", label: "plain" },
            ] as const
          ).map((c) => {
            const on = settings.termStyle === c.id;
            return (
              <button
                key={c.id}
                className={`settings-choice ${on ? "on" : ""}`}
                onClick={() => updateSettings({ termStyle: c.id })}
              >
                <span className="settings-dot" aria-hidden />
                <span className="settings-choice-name">{c.label}</span>
              </button>
            );
          })}
        </div>
        {/* the other half of where a version belongs: the launcher is where
            you see it, this is where you go to look it up */}
        <div className="settings-version">zero {__APP_VERSION__}</div>
      </div>
    </div>
  );
}
