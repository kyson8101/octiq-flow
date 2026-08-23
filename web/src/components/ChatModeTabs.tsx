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
        onClick={() => onPick(false)}
      >
        Single chat
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={room}
        className={`mode-tab ${room ? "is-on" : ""}`}
        onClick={() => onPick(true)}
      >
        Group chat
      </button>
    </div>
  );
}
