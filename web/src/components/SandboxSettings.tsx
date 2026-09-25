import { useState } from "react";
import { bridge } from "../lib/bridge";
import { useSandboxes } from "../lib/sandbox";

export function SandboxSettings() {
  const { snapshot, error, refresh } = useSandboxes();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const on = snapshot?.defaultEnabled ?? false;
  async function toggle() {
    setBusy(true); setFailure(null);
    try { await bridge.invoke("sandbox_configure", { enabled: !on }); await refresh(); }
    catch (e) { setFailure(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  }
  return <section className="settings-section" aria-labelledby="settings-sandbox-title">
    <header className="settings-section-head"><div>
      <h2 id="settings-sandbox-title">Sandbox</h2>
      <p>Run a separate test app and database for each chat on the OctiqFlow host.</p>
    </div></header>
    <div className="settings-control-row">
      <div className="settings-control-copy"><h3>Use sandbox for new chats</h3>
        <p>Set the default. You can change the checkbox before starting each new chat.</p></div>
      <button className={`set-switch${on ? " is-on" : ""}`} type="button" role="switch"
        aria-label="Use sandbox for new chats" aria-checked={on} disabled={busy || !snapshot}
        onClick={() => void toggle()}>
        <span className="set-switch-track" aria-hidden="true" />
        <span className="set-switch-text">{busy ? "…" : on ? "On" : "Off"}</span>
      </button>
    </div>
    <p className="settings-note">Each chat keeps its database when resumed. Existing chats keep their original choice.
      Projects need a sandbox recipe and Docker running locally on the host.</p>
    {(failure || error) && <p className="set-warn" role="alert">{failure || error}</p>}
  </section>;
}
