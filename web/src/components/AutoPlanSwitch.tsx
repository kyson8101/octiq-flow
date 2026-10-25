import { dropHeld, notePress, repeatsAnother } from "../lib/pressGuard";
import "./AutoPlan.css";

export function AutoPlanSwitch({ enabled, busy, ready, error, onChange }: {
  enabled: boolean; busy: boolean; ready: boolean; error?: string; onChange: () => void;
}) {
  return <section className="auto-plan-setting">
    <button type="button" className="auto-plan-switch" role="switch" aria-checked={enabled}
      aria-disabled={busy || !ready} onKeyDown={dropHeld} onClick={(event) => {
        if (busy || !ready || repeatsAnother(event)) { event.preventDefault(); return; }
        notePress(event);
        onChange();
      }}>
      <span>Auto-approve plans</span><span className="auto-plan-track" aria-hidden="true"><span /></span>
    </button>
    <p>Plans are approved when the lead's turn ends cleanly, if every waiting task runs at Auto or lower. A Full access task or a peer request leaves the whole plan for you to approve.</p>
    {error && <p className="auto-plan-error" role="alert">{error}</p>}
  </section>;
}
