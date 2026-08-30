// Everything you put away, and the way back.
//
// Shelving takes a project out of the sidebar, and the control that undoes it
// used to live inside that project's own settings — reached from the row that
// shelving had just removed. So it was a door that only opened one way, with
// eighteen projects behind it on this machine.
//
// A card each, and the card IS the button: there is exactly one thing you come
// here to do, so it does not hide behind a menu.
import { useState } from "react";
import { bridge } from "../lib/bridge";
import { RollingText } from "./RollingNumber";

export type ShelvedProject = {
  id: string;
  name: string;
  primary_path?: string;
  description?: string;
  paths?: string[];
};

export function ShelvedProjects({
  projects,
  onRestored,
  onClose,
}: {
  projects: ShelvedProject[];
  /** Reload the project list — the restored one belongs in the sidebar now. */
  onRestored: () => void;
  onClose: () => void;
}) {
  /** Which card is mid-restore, so it cannot be tapped twice. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Restored this visit. Kept on screen, marked, rather than vanishing —
   *  a card disappearing under your finger reads as "did that work?". */
  const [done, setDone] = useState<Set<string>>(new Set());
  /* The list as it was when this opened.
   *
   * Restoring reloads the projects, which takes the restored one out of
   * `projects` — so rendering the live prop made the card vanish the instant it
   * was tapped, which is the behaviour the marking above exists to avoid. The
   * snapshot holds it still until the modal is closed. */
  const [list] = useState(projects);

  const restore = async (p: ShelvedProject) => {
    if (busy || done.has(p.id)) return;
    setBusy(p.id);
    setError(null);
    try {
      await bridge.invoke("set_workspace_shelved", { id: p.id, shelved: false });
      setDone((prev) => new Set(prev).add(p.id));
      onRestored();
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside className="panel" role="dialog" aria-label="Shelved projects">
        <header className="panel-head">
          <div className="panel-id">
            <div className="panel-name">Shelved projects</div>
            {/* Not `panel-path`: that class is RTL so a path keeps its end
                when truncated, and a sentence borrowed it drew the count at the
                far end — "put away · tap one to bring it back 16". */}
            <div className="shelf-sub">
              <RollingText>{`${list.length - done.size} put away · tap one to bring it back`}</RollingText>
            </div>
          </div>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {error && <div className="shelf-error">{error}</div>}

        <div className="shelf-grid">
          {list.map((p) => {
            const restored = done.has(p.id);
            return (
              <button
                key={p.id}
                className={`shelf-card ${restored ? "is-done" : ""}`}
                type="button"
                disabled={!!busy || restored}
                onClick={() => void restore(p)}
              >
                <span className="shelf-card-name">{p.name}</span>
                {p.primary_path && (
                  // RTL + <bdi>: a path is identified by its end, and the box
                  // truncates from the left so the end survives. Without <bdi>
                  // the RTL box also reverses the text.
                  <span className="shelf-card-path">
                    <bdi>{p.primary_path}</bdi>
                  </span>
                )}
                {p.description && <span className="shelf-card-desc">{p.description}</span>}
                <span className="shelf-card-act">
                  {restored ? "Back in the list" : busy === p.id ? "Bringing back…" : "Bring back"}
                </span>
              </button>
            );
          })}
        </div>
      </aside>
    </>
  );
}
