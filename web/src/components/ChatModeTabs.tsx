/** Card 76 — what kind of chat this is, as one choice rather than a hidden
 *  switch and three stacked rows.
 *
 *  A room used to be turned on by a toggle buried in the settings sheet, after
 *  which the composer grew a target picker and a round bar above the input —
 *  three rows of chrome around one box. The strip replaces the toggle and gives
 *  the rest somewhere to belong: one mode is on at a time, and Single chat is
 *  the composer exactly as it was before rooms existed.
 *
 *  ## The strip IS the switch
 *
 *  There is no second way in. Two controls for one thing is two things that can
 *  disagree, and the one in Settings was the one nobody could find.
 *
 *  ## Both directions ask
 *
 *  Not because turning it ON is dangerous — that sends nothing anywhere by
 *  itself; adding an outside seat is the risky act and asks separately. Going
 *  BACK is the destructive one: it ends every seat's process, drops the seats,
 *  and forgets what was said so no future seat is shown it. The caller owns
 *  those questions, which is why this component only reports the pick.
 */
import "./ChatModeTabs.css";

/** One person. */
const ONE = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="8" r="3.6" />
    <path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6z" />
  </svg>
);

/** Several, overlapping — the shape a group has in every app that has one. */
const MANY = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="9" cy="8.5" r="3.2" />
    <circle cx="17" cy="9.5" r="2.4" />
    <path d="M2.5 20c0-3.3 2.9-5.1 6.5-5.1s6.5 1.8 6.5 5.1z" />
    <path d="M17 13.4c2.7 0 4.5 1.4 4.5 3.9h-4.1c0-1.5-.5-2.8-1.4-3.8z" />
  </svg>
);

export function ChatModeTabs({
  room,
  onPick,
}: {
  /** Whether this chat is a room. `false` is every chat that has never been one. */
  room: boolean;
  /** The mode picked. Fired even when it matches the current one; the caller
   *  decides whether that is a no-op, because only the caller knows whether a
   *  confirmation is pending. */
  onPick: (room: boolean) => void;
}) {
  return (
    <div className="mode-tabs" role="tablist" aria-label="Chat mode">
      <button
        type="button"
        role="tab"
        aria-selected={!room}
        className={`mode-tab ${room ? "" : "is-on"}`}
        /* Named, not just drawn. An icon with no name is a mystery to a
           screen reader and to anyone who has not learned it yet — and
           `aria-label` is how every other icon button in this composer does
           it. */
        aria-label="Single chat"
        title="Single chat"
        onClick={() => onPick(false)}
      >
        {ONE}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={room}
        className={`mode-tab ${room ? "is-on" : ""}`}
        aria-label="Group chat"
        title="Group chat"
        onClick={() => onPick(true)}
      >
        {MANY}
      </button>
    </div>
  );
}
