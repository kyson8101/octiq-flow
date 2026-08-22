// The app's own settings, as opposed to a project's.
//
// Only one thing lives here so far — the theme — but it is deliberately a
// SETTINGS sheet and not a theme sheet, because the next app-wide switch has
// to have somewhere to go that is not the top bar.
//
// Choosing applies at once and there is no Save. That is the same rule the
// project sheet follows: on a phone, a Save button you can lose by swiping is
// worse than a change you can undo by choosing again.
import { applyTheme, preview, THEMES } from "../lib/themeStore";

export function Settings({ current, onPick, onClose }: {
  /** The chosen theme's id. Held by App so the sheet can close and reopen
   *  without forgetting, and so nothing re-reads localStorage to draw a tick. */
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const choose = (id: string) => {
    applyTheme(id);
    onPick(id);
  };

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside className="panel" role="dialog" aria-label="Settings">
        <header className="panel-head">
          <div className="panel-id">
            <div className="panel-name">Settings</div>
          </div>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="panel-body set-body">
          <div className="set-field">
            <span className="set-label">Theme</span>
            <p className="set-hint">
              Colours only. The text and terminal fonts stay as they are.
            </p>

            <div className="thm-grid" role="radiogroup" aria-label="Theme">
              {THEMES.map((theme) => {
                const p = preview(theme);
                const on = theme.id === current;
                return (
                  <button
                    key={theme.id}
                    className={`thm${on ? " is-on" : ""}`}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => choose(theme.id)}
                  >
                    {/* A small picture of the app rather than a row of dots:
                        which colour is the background and which is the one
                        button is the thing worth knowing, and a dot cannot
                        say that. */}
                    <span className="thm-shot" style={{ background: p.bg }} aria-hidden="true">
                      <span className="thm-bar" style={{ background: p.sunken }} />
                      <span className="thm-card" style={{ background: p.card }} />
                      <span className="thm-line" style={{ background: p.fg }} />
                      <span className="thm-dot" style={{ background: p.accent }} />
                    </span>
                    <span className="thm-name">{theme.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
