/** Card 68 — putting one thing to every seat, and cutting in when you have heard
 *  enough.
 *
 *  A ROUND asks each seat the same thing in turn, and shows each one what the
 *  seats before it said. It runs in the BACKEND, not here — a round takes
 *  minutes, and one driven from the browser would die the moment a laptop lid
 *  shut. So this bar starts one, watches it, and stops it; it never sequences
 *  anything itself.
 *
 *  ## Cutting in has to be reachable WHILE it runs
 *
 *  The whole value of the hand is that the seats still waiting never run and are
 *  never billed. A stop button that only appeared after the round finished would
 *  be a button for undoing nothing.
 *
 *  ## Absent in an ordinary chat
 *
 *  No seats, no bar. A control that can never do anything must not appear in
 *  every chat in the app.
 */
import type { Seat } from "../lib/chat";
import { AgentLogo } from "./AgentLogo";

import "./RoundBar.css";

/** Put it to everyone: a small burst going outward. */
const ASK = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <circle cx="4.5" cy="7" r="2" />
    <circle cx="19.5" cy="7" r="2" />
    <circle cx="4.5" cy="17" r="2" />
    <circle cx="19.5" cy="17" r="2" />
  </svg>
);

/** A line drawn under what came before. */
const CUT = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M3 12h18" strokeLinecap="round" />
    <path d="M6 6.5h12" strokeLinecap="round" opacity="0.35" />
    <path d="M6 17.5h12" strokeLinecap="round" opacity="0.35" />
  </svg>
);

/** A round as the backend reports it (`chat_round_state`). */
export type RoundState = {
  running: boolean;
  /** The user cut in. Whatever is left in `waiting` will never run. */
  hand: boolean;
  /** Seat ids still to speak, in order. */
  waiting: string[];
  /** Who has spoken, and whether they actually answered. */
  said: { name: string; answered: boolean }[];
};

export function RoundBar({
  seats,
  round,
  onAsk,
  onStop,
  onNewTopic,
  topicDrawn,
}: {
  seats: Seat[];
  /** The round in flight, or `null` when none is. */
  round: RoundState | null;
  onAsk: () => void;
  onStop: () => void;
  /** Card 69 — draw a line: nothing said before now reaches a seat again. */
  onNewTopic?: () => void;
  /** Whether a line has already been drawn in this chat. */
  topicDrawn?: boolean;
}) {
  if (seats.length === 0) return null;
  const live = round?.running ?? false;

  if (!live) {
    return (
      <div className="round-bar">
        {/* Card 78 — an icon in the toolbar. The NAME stays on the button, for
            a screen reader and for anyone who has not learned the shape. */}
        <button
          type="button"
          className="round-ask"
          aria-label="Ask the room"
          title="Ask the room"
          onClick={onAsk}
        >
          {ASK}
        </button>
        {/* Only BETWEEN rounds. Cutting the history out from under seats that
            are mid-discussion would leave the ones still to speak answering a
            question they cannot see the start of. */}
        {onNewTopic && (
          <button
            type="button"
            className="round-topic"
            aria-label="New topic"
            title="New topic — nothing said before now is shown to any seat again"
            onClick={onNewTopic}
          >
            {CUT}
          </button>
        )}
        {/* The transcript used to carry a rule saying this. Every notice about
            the room now lives in the composer — but it must not simply vanish:
            what the seats can no longer see is a fact worth checking. */}
        {topicDrawn && <span className="round-note">earlier talk is not sent</span>}
      </div>
    );
  }

  const byId = new Map(seats.map((s) => [s.id, s]));

  return (
    <div className="round-bar is-live">
      <span className="round-said">
        {round?.said.map((s) => (
          <span key={s.name} className={`round-who ${s.answered ? "" : "is-quiet"}`}>
            {s.name}
            {/* A seat that fell over is named as such rather than counted as an
                answer — the round carried on without it, and the screen has to
                agree with the brief the next seat was given. */}
            {!s.answered && <span className="round-none"> — no answer</span>}
          </span>
        ))}
      </span>

      {round?.hand ? (
        <span className="round-note">stopped</span>
      ) : (
        <>
          <span className="round-next">
            {round?.waiting.map((id) => {
              const seat = byId.get(id);
              if (!seat) return null;
              return (
                <span key={id} className="round-who is-waiting">
                  <AgentLogo agent={seat.agent === "claude" ? "claude" : "codex"} size={11} />
                  {seat.name}
                </span>
              );
            })}
          </span>
          <button type="button" className="round-stop" onClick={onStop}>
            Stop
          </button>
        </>
      )}
    </div>
  );
}
