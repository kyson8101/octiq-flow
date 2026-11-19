// The rows of the group above the composer (`ChatStatus`) about what an
// agent's chat runs on:
//
// - the way back, while the chat runs on an automatic fallback: `Running on
//   Codex · Opus limit resets 3:40 PM` and one press, `Back to Opus`. The
//   press is offered even while the provider is limited, because the person
//   may know the limit is back; the host decides, and its refusal is said
//   here, in words, where the press was made. No automatic return exists:
//   swapping the model under running work is the person's call.
// - a switch waiting for the turn's full stop: `Switches to Opus after this
//   turn`, quiet text with nothing to press (picking the runtime already
//   running in the sheet takes it back).
//
// Both are the group's own rows: the shared `.status-row` frame, one line cut
// inside the row, the button never giving way. They are neutral: the accent
// is a turn in flight and `--warn` a problem, and neither is one.
import { useEffect, useState } from "react";
import { ActionIcon } from "./ActionIcon";
import { StatusDismiss } from "./ChatStatus";
import { dropHeld, notePress, repeatsAnother } from "../lib/pressGuard";
import { useInFlight } from "../lib/inFlight";
import type { Provider } from "../lib/agentProviders";
import {
  homeWords, msToReset, pendingLine, runtimeFlight,
  type ChatRuntime, type HomeRuntime,
} from "../lib/runtimeSwitch";

/** One timer, set for the moment the host says the limit resets, that draws
 *  the row again so its words change. Nothing polls: with no reset to wait
 *  for there is no timer, and a reset further off than a timer can hold is
 *  waited for in steps. */
function useResetTick(home: HomeRuntime | undefined): void {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const wait = msToReset(home, Date.now());
    if (wait === undefined) return;
    const timer = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(timer);
  }, [home?.limited, home?.resetsAt, tick]);
}

export function RuntimeRows({
  chat,
  current,
  runtime,
  refusal,
  onBack,
  onDismissRefusal,
}: {
  chat: string;
  /** The provider the chat runs on now. */
  current: Provider;
  runtime: ChatRuntime | undefined;
  /** The host's sentence for a press made on this row, whole. */
  refusal?: string;
  onBack: (home: HomeRuntime) => void;
  onDismissRefusal: () => void;
}) {
  const home = runtime?.home;
  const pending = runtime?.pending;
  const sending = useInFlight(runtimeFlight(chat));
  useResetTick(home);
  if (!home && !pending) return null;
  const words = home ? homeWords(current, home, Date.now()) : null;
  return (
    <>
      {home && words && (
        <div className="runtime-row status-row" data-kind="home" role="status" aria-label={words.line}>
          <span className="status-row-icon" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8h13l-3-3M20 16H7l3 3" />
            </svg>
          </span>
          <span className="runtime-row-copy">
            <span className="runtime-row-label">{words.label}</span>
            <span className="runtime-row-detail">{words.detail}</span>
            {refusal && <span className="runtime-row-refusal" role="alert">{refusal}</span>}
          </span>
          <button type="button" className="runtime-back" data-icon-action title={words.back} aria-label={words.back}
            aria-disabled={sending || undefined} aria-busy={sending || undefined}
            onKeyDown={dropHeld}
            onClick={(event) => {
              // No question stands in front of this answer, so a press that
              // repeats the one that brought it under the pointer is dropped.
              if (sending || repeatsAnother(event)) { event.preventDefault(); return; }
              notePress(event);
              onBack(home);
            }}>
            <ActionIcon name="swap" label={words.back} />
          </button>
          {refusal && <StatusDismiss label="Dismiss" onClick={onDismissRefusal} />}
        </div>
      )}
      {pending && (
        <div className="runtime-row status-row" data-kind="pending" role="status">
          <span className="status-row-icon" aria-hidden="true">
            <span className="runtime-pending-dot" />
          </span>
          <span className="runtime-row-copy">
            <span className="runtime-row-detail">{pendingLine(pending)}</span>
          </span>
        </div>
      )}
    </>
  );
}
