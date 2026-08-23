/** Card 66 — the switch that turns a chat into a room, and who is in it.
 *
 *  A chat has always been one agent. Turning this on lets it hold several: a
 *  host plus any number of SEATS, each its own agent with its own session, and
 *  every message on screen then says which of them wrote it.
 *
 *  ## Off is the default, and off means invisible
 *
 *  With the switch off this draws the switch and NOTHING else — no seat list,
 *  no add button, no empty box explaining what a room is. A chat that is not a
 *  room has to read exactly as it read before rooms existed, and a control that
 *  is merely disabled still changes what the page looks like.
 *
 *  It stays off even if a stale seat list reaches it. What is drawn matches what
 *  the user turned off, never what some other layer still remembers.
 *
 *  ## Presentational
 *
 *  No socket calls. The backend commands (`chat_set_room`, `chat_add_agent`,
 *  `chat_remove_agent`) are the caller's to make — the same shape `Composer`
 *  already uses, and the reason this can be tested by rendering it to a string.
 */
import type { Seat } from "../lib/chat";
import { AgentLogo } from "./AgentLogo";

import "./RoomPanel.css";

/** The agents a seat can be. The backend's allowlist is `claude` | `codex`;
 *  card 71 adds seats with no CLI behind them at all. */
const CAN_ADD: { agent: "claude" | "codex"; label: string }[] = [
  { agent: "claude", label: "Claude" },
  { agent: "codex", label: "Codex" },
];

export function RoomPanel({
  room,
  seats,
  onToggle,
  onAdd,
  onRemove,
}: {
  /** Whether this chat is a room. Off for every chat that has never been one. */
  room: boolean;
  seats: Seat[];
  onToggle: (open: boolean) => void;
  onAdd: (agent: "claude" | "codex") => void;
  onRemove: (seatId: string) => void;
}) {
  return (
    <>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={room}
        className={`picker-item is-bypass ${room ? "is-on" : ""}`}
        title="Let this chat hold more than one agent"
        onClick={() => onToggle(!room)}
      >
        <span className="picker-name">Several agents</span>
        <span className="picker-switch">{room ? "On" : "Turn on"}</span>
      </button>

      {/* Everything below exists only when the switch is on. Not disabled —
          absent. */}
      {room && (
        <div className="room-body">
          {seats.length === 0 ? (
            <p className="room-empty">Nobody else is here yet.</p>
          ) : (
            <ul className="room-seats">
              {seats.map((seat) => (
                <li key={seat.id} className="room-seat">
                  <AgentLogo agent={seat.agent === "claude" ? "claude" : "codex"} size={13} />
                  <span className="room-seat-name">{seat.name}</span>
                  {/* What it was added FOR. Absent for a seat added without a
                      reason, rather than drawn as an empty line. */}
                  {seat.role && <span className="room-seat-role">{seat.role}</span>}
                  {/* The one thing about a seat worth saying on a list this
                      short: an outside seat's whole value is what it CANNOT
                      see, and unmarked it looks like another copy of the host. */}
                  {seat.context === "room_only" && (
                    <span className="room-seat-blind" title="Cannot see the project">
                      room-only
                    </span>
                  )}
                  <button
                    type="button"
                    className="room-seat-drop"
                    aria-label={`Remove ${seat.name}`}
                    onClick={() => onRemove(seat.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="room-add">
            <span className="room-add-label">Add an agent</span>
            {CAN_ADD.map((a) => (
              <button
                key={a.agent}
                type="button"
                className="room-add-btn"
                onClick={() => onAdd(a.agent)}
              >
                <AgentLogo agent={a.agent} size={13} />
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
