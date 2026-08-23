/** Card 67 — who the next message is for.
 *
 *  A room holds a host and any number of seats. By default a message goes to the
 *  host, which is where every message has always gone; this is how you send one
 *  to a named seat instead.
 *
 *  ## It is absent, not disabled, when there is no choice
 *
 *  A chat with no seats has nothing to choose between, so this draws nothing at
 *  all. A picker with one entry is a control that can never change anything, and
 *  it would appear in every ordinary chat — which is the whole set of chats until
 *  someone opens a room.
 *
 *  ## Presentational
 *
 *  The seats come from the caller and the choice goes back to it. No socket
 *  calls, which is what lets this be tested by rendering it to a string.
 */
import type { Seat } from "../lib/chat";
import { AgentLogo } from "./AgentLogo";

import "./TargetPicker.css";

export function TargetPicker({
  seats,
  to,
  onPick,
  open = false,
  onOpen,
}: {
  /** Who is in the room. Empty in an ordinary chat. */
  seats: Seat[];
  /** The seat id currently chosen, or `null` for the whole room. */
  to: string | null;
  onPick: (seatId: string | null) => void;
  /** Whether the full list is showing. */
  open?: boolean;
  onOpen?: (open: boolean) => void;
}) {
  if (seats.length === 0) return null;

  const chosen = seats.find((s) => s.id === to);
  const label = chosen?.name ?? "Everyone";

  return (
    <div className="target-pick">
      {/* Card 78 — ONE control, not a pill per seat. This sits in a row that
          already holds seven others, and a room with four seats would eat it. */}
      <button
        type="button"
        className="target-now"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Sending to ${label}`}
        onClick={() => onOpen?.(!open)}
      >
        {chosen && (
          <AgentLogo agent={chosen.agent === "claude" ? "claude" : "codex"} size={12} />
        )}
        {label}
      </button>

      {open && (
        <>
          <div className="target-scrim" onClick={() => onOpen?.(false)} />
          <div className="target-menu" role="listbox" aria-label="Send to">
            <button
              type="button"
              role="option"
              aria-selected={to === null}
              className={`target-opt ${to === null ? "is-on" : ""}`}
              onClick={() => {
                onPick(null);
                onOpen?.(false);
              }}
            >
              Everyone
            </button>
            {seats.map((seat) => (
              <button
                key={seat.id}
                type="button"
                role="option"
                aria-selected={to === seat.id}
                className={`target-opt ${to === seat.id ? "is-on" : ""}`}
                onClick={() => {
                  onPick(seat.id);
                  onOpen?.(false);
                }}
              >
                <AgentLogo agent={seat.agent === "claude" ? "claude" : "codex"} size={12} />
                {seat.name}
                {/* Said here as well as on the room panel, because this is
                    where the choice is actually made: picking a seat without
                    knowing it cannot see the project is picking blind. */}
                {seat.context === "room_only" && (
                  <span className="target-blind" title="Cannot see the project">
                    room-only
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
