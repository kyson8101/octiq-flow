/** Card 66 — who is in this chat, and how somebody else gets in.
 *
 *  A chat has always been one agent. It can hold several: a host plus any number
 *  of SEATS, each its own agent with its own session, and every message on screen
 *  then says which of them wrote it.
 *
 *  ## Card 82 — there is nothing to switch on first
 *
 *  This used to draw NOTHING until room mode was turned on, which made adding
 *  the first agent a two-step act: find the switch, then find this. A seat is
 *  what makes a chat a group, so the control that adds one has to work in a chat
 *  that is not one yet.
 *
 *  What that costs is honest and small: every chat carries a short "nobody else
 *  is here yet" and a way to change that, one button away. It costs nothing
 *  anywhere else — the transcript, the composer row and the header all stay
 *  exactly as they were until somebody actually joins.
 *
 *  ## Card 90 — one panel, one subject
 *
 *  That button used to open the SETTINGS sheet, with this fourth in it under
 *  Model, Access and Effort. Now it opens this alone: a dropdown over the row on
 *  a wide screen, `RoomSheet` below on a phone.
 *
 *  ## Presentational
 *
 *  No socket calls. The backend commands (`chat_add_agent`, `chat_remove_agent`)
 *  are the caller's to make — the same shape `Composer` already uses, and the
 *  reason this can be tested by rendering it to a string.
 */
import type { Seat } from "../lib/chat";
import { AgentLogo } from "./AgentLogo";

import "./RoomPanel.css";

/** The agents a seat can be. The backend's allowlist is `claude` | `codex`;
 *  card 71 adds seats with no CLI behind them at all. */
/** What can be added, and what each one is.
 *
 *  A RESIDENT is a CLI agent on this machine, with a process of its own. An
 *  ON-DEMAND seat is an HTTP call with nothing behind it between questions —
 *  cheap to keep around, and with no memory of its own.
 *
 *  The DeepSeek row defaults to `room_only` because that is the whole reason to
 *  add it: it cannot see the project, so it reads as a newcomer would. A seat
 *  that can read the files ends up agreeing with the host. */
const CAN_ADD: {
  label: string;
  agent: "claude" | "codex";
  kind?: "on_demand";
  provider?: string;
  context?: "room_only";
}[] = [
  { label: "Claude", agent: "claude" },
  { label: "Codex", agent: "codex" },
  {
    label: "DeepSeek",
    // The logo only knows the two CLI marks; `agent` here is what to DRAW, and
    // `provider` is what actually answers.
    agent: "codex",
    kind: "on_demand",
    provider: "deepseek",
    context: "room_only",
  },
];

export function RoomPanel({
  seats,
  onAdd,
  onRemove,
}: {
  seats: Seat[];
  onAdd: (want: (typeof CAN_ADD)[number]) => void;
  onRemove: (seatId: string) => void;
}) {
  return (
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
              {/* No process behind it: it costs nothing while it sits
                  there, and remembers nothing between questions. Both
                  matter to whoever is choosing who to ask. */}
              {seat.kind === "on_demand" && (
                <span
                  className="room-seat-kind"
                  title="No process — asked directly, answers, gone"
                >
                  {/* "on demand" says there is no process behind it. WHICH
                      service answers is the other half, and the half that
                      decides whether the answer is worth anything. */}
                  on demand{seat.provider ? ` · ${seat.provider}` : ""}
                </span>
              )}
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
            key={a.label}
            type="button"
            className="room-add-btn"
            onClick={() => onAdd(a)}
          >
            <AgentLogo agent={a.agent} size={13} />
            {a.label}
          </button>
        ))}
      </div>

      {/* Said HERE, where the decision is made, and not only on the seat
          afterwards.

          A seat marked `room_only` cannot open your files — but what it is
          SENT is the room's discussion, and that routinely contains code a
          resident agent pasted in. "Cannot see the project" is true about
          the filesystem and misleading about what leaves the machine, which
          is the thing anyone actually cares about. */}
      <p className="room-warn">
        An outside service is sent what is said in this room. It cannot open
        your files, but anything quoted into the chat goes with the question.
      </p>
    </div>
  );
}

/** Card 90 — the room on its own, as a sheet.
 *
 *  It used to be the FOURTH group of the settings sheet, under Model, Access
 *  and Effort. So adding somebody meant opening a sheet about the agent you are
 *  already talking to, scrolling past three of its settings, and finding the
 *  room at the bottom — and the person+ button in the composer row opened that
 *  same pile. It opens this instead, and this holds one thing.
 *
 *  The same shell as the settings sheet (`.sheet`), so it rises from the same
 *  edge and Done closes it the same way. On a wide screen the button opens the
 *  panel as a dropdown over the row instead; there a sheet would be a whole
 *  screen of furniture for three buttons.
 */
export function RoomSheet({
  seats,
  onAdd,
  onRemove,
  onDone,
}: {
  seats: Seat[];
  onAdd: (want: (typeof CAN_ADD)[number]) => void;
  onRemove: (seatId: string) => void;
  onDone: () => void;
}) {
  return (
    <div className="sheet room-sheet" role="dialog" aria-label="Who is in this chat">
      <div className="sheet-body">
        <div className="sheet-group">
          <div className="sheet-head">Who is in this chat</div>
          <RoomPanel seats={seats} onAdd={onAdd} onRemove={onRemove} />
        </div>
      </div>

      <div className="sheet-foot">
        <button className="sheet-done" type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
