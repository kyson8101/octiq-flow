import { dropHeld, notePress, repeatsAnother } from "../lib/pressGuard";
import "./AutoPlan.css";

export function AutoPlanSwitch({ enabled, includeFull, busy, ready, error, onChange, onFullChange }: {
  enabled: boolean; includeFull: boolean; busy: boolean; ready: boolean; error?: string; onChange: () => void; onFullChange: () => void;
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
    <p>Plans are approved when the lead's turn ends cleanly. Auto or lower is included; Full access is a separate opt-in. A peer request always waits for you.</p>
    {enabled && <>
      <button type="button" className="auto-plan-switch" role="switch" aria-checked={includeFull}
        aria-disabled={busy || !ready} onKeyDown={dropHeld} onClick={(event) => {
          if (busy || !ready || repeatsAnother(event)) { event.preventDefault(); return; }
          notePress(event);
          onFullChange();
        }}>
        <span>Include Full access tasks</span><span className="auto-plan-track" aria-hidden="true"><span /></span>
      </button>
      <p>Full access workers run with no permission checks; plans with them are approved without you.</p>
    </>}
    {error && <p className="auto-plan-error" role="alert">{error}</p>}
  </section>;
}
