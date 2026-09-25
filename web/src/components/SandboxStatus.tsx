import { useState } from "react";
import { bridge } from "../lib/bridge";
import type { SandboxEnvironment } from "../lib/sandbox";
import "./SandboxStatus.css";

export function SandboxStatus({ environment: env, running, onRefresh }: {
  environment: SandboxEnvironment; running: boolean; onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  async function act(action: string) {
    setBusy(true); setError(null);
    try {
      // The host atomically refuses a running turn and ends only an idle agent.
      await bridge.invoke("sandbox_action", { key: env.chatKey, action, confirmation: action === "reset" ? env.id : null });
      setConfirmReset(false);
    } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { setBusy(false); await onRefresh(); }
  }
  const disabled = busy || running || env.state === "preparing";
  return <details className="sandbox-status">
    <summary>Sandbox · {busy || env.state === "preparing" ? "Preparing…" : env.state === "ready" ? "Checks passed" : env.state}
      {env.checkedAt && <span>Checked {new Date(env.checkedAt).toLocaleTimeString()}</span>}
    </summary>
    <div className="sandbox-status-body">
      <p>Test services run on the OctiqFlow host. {env.state === "ready" ? "Readiness checks passed; application acceptance is still unverified." : "Services must pass readiness checks before this chat can run."}</p>
      {env.state === "ready" && <div className="sandbox-links">{Object.entries(env.urls).map(([name, url]) =>
        <a key={name} href={url} target="_blank" rel="noreferrer">{name} ↗</a>)}
      </div>}
      {Object.keys(env.urls).length > 0 && <p>Local links open on the host computer.</p>}
      <small>{env.fixtureVersion ? `Fixture: ${env.fixtureVersion} · ` : ""}{env.sourceRevision?.slice(0, 8)}{env.sourceDirty ? " (local changes)" : ""}</small>
      {(error || env.error) && <p role="alert">{error || env.error}</p>}
      <div className="sandbox-actions">
        <button type="button" disabled={disabled} onClick={() => void act("start")}>Start / check</button>
        <button type="button" disabled={disabled} onClick={() => void act("stop")}>Stop services</button>
        <button type="button" disabled={disabled} onClick={() => setConfirmReset(true)}>Reset database…</button>
      </div>
      {running && <p>Available when the current turn finishes.</p>}
      {confirmReset && <div className="sandbox-reset" role="group" aria-label="Confirm database reset">
        <p>Delete this chat’s database and restore its seed? All changes inside this sandbox will be lost.</p>
        <button type="button" disabled={disabled} onClick={() => void act("reset")}>Delete database and restore seed</button>
        <button type="button" onClick={() => setConfirmReset(false)}>Cancel</button>
      </div>}
    </div>
  </details>;
}
