import { useState } from "react";
import { clockLabel, fullLabel } from "../lib/messageTime";
import "./MessageTime.css";

/** The small clock under a message, WhatsApp-style (`14:32`, `2:32 PM`).
 *
 *  It is a button so the whole date and time are reachable by focus and by a
 *  tap, not by a hover alone: pressing it writes them out in place of the
 *  clock, Escape or leaving it puts the clock back. The same words are its
 *  `title` and its accessible name. Muted ink only: the accent is a turn in
 *  flight. Nothing is drawn for a message with no time. */
export function MessageTime({ at, className = "" }: { at?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  if (at === undefined) return null;
  const full = fullLabel(at);
  return (
    <button type="button" className={`message-time${open ? " is-open" : ""} ${className}`.trim()}
      title={full} aria-label={full} aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); } }}>
      <time dateTime={new Date(at).toISOString()}>{open ? full : clockLabel(at)}</time>
    </button>
  );
}

/** The divider between two days: a hairline either side of `Today`,
 *  `Yesterday` or a date. Not a message and not a turn: it carries no
 *  `data-map-turn`, so the conversation map never sees it. */
export function DayDivider({ label, full }: { label: string; full: string }) {
  return (
    <div className="day-divider" role="separator" aria-label={full} title={full}>
      <span>{label}</span>
    </div>
  );
}
