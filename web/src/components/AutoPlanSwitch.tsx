import { dropHeld, notePress } from "../lib/pressGuard";
import "./AutoPlan.css";

export function AutoPlanSwitch({ enabled, busy, ready, error, onChange }: {
  enabled: boolean; busy: boolean; ready: boolean; error?: string; onChange: () => void;
}) {
  return <section className="auto-plan-setting">
    <button type="button" className="auto-plan-switch" role="switch" aria-checked={enabled}
      disabled={busy || !ready} onKeyDown={dropHeld} onClick={(event) => { notePress(event); onChange(); }}>
      <span>Auto-approve plans</span><span className="auto-plan-track" aria-hidden="true"><span /></span>
    </button>
    <p>Plans whose tasks run at Auto or lower are approved when the lead's turn ends. Full access tasks and peer requests still wait for you.</p>
    {error && <p className="auto-plan-error" role="alert">{error}</p>}
  </section>;
}
