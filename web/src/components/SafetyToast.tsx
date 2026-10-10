// The short notice for an auto-mode refusal the agent carried on past: one
// line over the foot of the transcript, gone again in a few seconds. What it
// stands for stays in the transcript as a folded line (see SafetyBlock), so
// nothing is lost when it leaves.
import { useEffect, useRef, useState } from "react";
import { AUTO_MODE_BLOCKED, NOTHING_RAN, type SafetyToastState } from "../lib/safetyToast";
import "./SafetyToast.css";

/** How long the notice stays, not counting time under the pointer or focus. */
export const SAFETY_TOAST_MS = 5000;
/** The fade on the way out. Kept in step with `.safety-toast.is-leaving`. */
const LEAVE_MS = 180;

function WarnIcon() {
  return (
    <svg className="safety-toast-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5 2.8 19.5h18.4L12 3.5Z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17" r=".6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function SafetyToast({
  toast,
  onDetails,
  onDone,
  lifetime = SAFETY_TOAST_MS,
}: {
  /** What to show, or null for nothing at all. */
  toast: SafetyToastState | null;
  /** Open the transcript's line for this refusal. The notice then leaves. */
  onDetails: (blockId: string) => void;
  /** The notice has finished leaving. */
  onDone: () => void;
  lifetime?: number;
}) {
  if (!toast) return null;
  return <Shown toast={toast} onDetails={onDetails} onDone={onDone} lifetime={lifetime} />;
}

function Shown({
  toast,
  onDetails,
  onDone,
  lifetime,
}: {
  toast: SafetyToastState;
  onDetails: (blockId: string) => void;
  onDone: () => void;
  lifetime: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const held = hovered || focused;
  // What is left of the lifetime: a pause keeps it, a newer refusal refills it.
  const left = useRef(lifetime);
  const done = useRef(onDone);
  done.current = onDone;

  // Before the clock below, so a newer refusal restarts it from full.
  useEffect(() => {
    left.current = lifetime;
    setLeaving(false);
  }, [toast.blockId, lifetime]);

  useEffect(() => {
    if (held || leaving) return;
    const started = performance.now();
    const timer = window.setTimeout(() => setLeaving(true), left.current);
    return () => {
      window.clearTimeout(timer);
      left.current = Math.max(0, left.current - (performance.now() - started));
    };
  }, [held, leaving, toast.blockId, lifetime]);

  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => done.current(), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  const count = toast.seen.length;
  return (
    <div className="safety-toast-slot">
      <div
        className={`safety-toast${count > 1 ? " is-many" : ""}${leaving ? " is-leaving" : ""}`}
        role="status"
        aria-live="polite"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
      >
        <WarnIcon />
        <span className="safety-toast-text">
          {count > 1 && <span className="safety-toast-count">{count} blocked</span>}
          <span className="safety-toast-what">{AUTO_MODE_BLOCKED}</span>
          {toast.reason && <span className="safety-toast-reason">{toast.reason}</span>}
          <span className="safety-toast-calm">{NOTHING_RAN}</span>
        </span>
        <button className="safety-toast-details" type="button" onClick={() => onDetails(toast.blockId)}>
          Details
        </button>
      </div>
    </div>
  );
}
