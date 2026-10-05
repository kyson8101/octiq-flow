import { useEffect, useState } from "react";
import { charCount } from "../lib/agentsMode";
import {
  loadPersonalPreferences, PERSONAL_PREFERENCES_MAX, savePersonalPreferences,
} from "../lib/personalPreferences";
import { CharCounter } from "./AgentsSettings";

/** Settings → Personal preferences: the person's own words, carried at the
 *  end of every agent chat's system prompt. Saved on the server, because the
 *  server is what starts the agents. */
export function PreferencesSettings() {
  const [saved, setSaved] = useState("");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    loadPersonalPreferences()
      .then((value) => { if (alive) { setSaved(value.text); setText(value.text); } })
      .catch((reason) => { if (alive) setError(String(reason)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  async function save(next: string) {
    setBusy(true); setError(""); setDone(false);
    try {
      const value = await savePersonalPreferences(next);
      setSaved(value.text); setText(value.text); setDone(true);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  return <section className="settings-section" aria-labelledby="preferences-title">
    <header className="settings-section-head"><div>
      <h2 id="preferences-title">Personal preferences</h2>
      <p>How you like every agent to work with you, in your own words.</p>
    </div></header>
    <PreferencesBlock saved={saved} text={text} loading={loading} busy={busy} done={done}
      onChange={(next) => { setText(next); setDone(false); }}
      onSave={() => void save(text)} onClear={() => void save("")} />
    {error && <p className="set-warn" role="alert">{error}</p>}
  </section>;
}

export function PreferencesBlock({ saved, text, loading, busy, done, onChange, onSave, onClear }: {
  saved: string;
  text: string;
  loading: boolean;
  busy: boolean;
  done: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const changed = text.trim() !== saved.trim();
  const over = charCount(text) > PERSONAL_PREFERENCES_MAX;
  return (
    <form className="agent-policy" aria-labelledby="preferences-field"
      onSubmit={(event) => { event.preventDefault(); if (changed && !over) onSave(); }}>
      <div className="team-field-head">
        <h3 id="preferences-field">Added to every chat</h3>
        <CharCounter text={text} max={PERSONAL_PREFERENCES_MAX} />
      </div>
      <p className="settings-note" id="preferences-hint">
        Ends the system prompt of every chat OctiqFlow starts: any agent, any project, the front desk and task workers included. A chat that is already running picks up a change the next time it starts or resumes.
      </p>
      <textarea
        className="agent-policy-text"
        aria-labelledby="preferences-field"
        aria-describedby="preferences-hint"
        value={text}
        maxLength={PERSONAL_PREFERENCES_MAX}
        rows={8}
        disabled={loading || busy}
        placeholder="e.g. Reply in British English. Keep answers short and put the conclusion first. I work on a Mac."
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="agent-policy-actions">
        {done && !changed && <span className="settings-note" role="status">Saved</span>}
        <button className="vault-button" type="button" disabled={loading || busy || !saved}
          onClick={onClear}>Clear</button>
        <button className="settings-primary" type="submit" disabled={loading || busy || !changed || over}>
          {busy ? "Saving…" : "Save preferences"}
        </button>
      </div>
    </form>
  );
}
