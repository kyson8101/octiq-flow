// The composer's status pieces: the context meter and the working line (moved verbatim from Composer.tsx).
import { ActionIcon } from "./ActionIcon";
import { useEffect, useState } from "react";
import { elapsedLabel, workingLine } from "../lib/working";
import { Mascot } from "./Mascot";
import type { AgentIdentity } from "../lib/agentsMode";
import { RollingText } from "./RollingNumber";
import { useLate } from "../lib/useArrival";
import { asksPerson, RECHECK_LABEL, WAIT_WORDS, type ChatHold } from "../lib/chatWait";
import { turnElapsed, type TurnWaits } from "../lib/turnClock";
import { type ComposerStyle } from "../lib/agentProviders";

export function ContextMeter({ tokens, window, scope }: { tokens?: number; window?: number; scope: string }) {
  // Known only once the transcript has been read back: it comes in beside
  // Send, in room that was already there, rather than appearing.
  const late = useLate(!!tokens && !!window, scope);
  if (!tokens || !window) return null;
  const percent = Math.min(100, Math.round((tokens / window) * 100));
  const level = percent >= 90 ? "is-danger" : percent >= 70 ? "is-warn" : "";
  // A circle drawn with a dash: the visible run is the used share of it.
  const R = 7;
  const C = 2 * Math.PI * R;

  return (
    <span
      className={`ctx ${level}${late ? " enter-fade" : ""}`}
      title={`Context: ${short(tokens)} of ${short(window)} used (${percent}%)`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle className="ctx-track" cx="9" cy="9" r={R} fill="none" strokeWidth="2.5" />
        <circle
          className="ctx-fill"
          cx="9"
          cy="9"
          r={R}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(percent / 100) * C} ${C}`}
          // Start the run at the top rather than at three o'clock.
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="ctx-val">
        <RollingText>{`${percent}%`}</RollingText>
      </span>
    </span>
  );
}

/** The status line while a turn runs: elapsed time and current activity.
 *
 *  It keeps its own second hand rather than being handed an elapsed time, so
 *  the clock advances between agent events — a turn can go a whole minute
 *  without one. The interval lives and dies with the component, and the
 *  component only exists while the chat is busy, so an idle chat ticks nothing.
 *  Nothing above it re-renders either: the second belongs to this span. */
export function Working({
  since,
  activity,
  thinking,
  background,
  robot,
  persona,
  waits,
  waiting,
  onRecheck,
}: {
  /** A registered agent works under its own face, not a model's robot. */
  persona?: AgentIdentity | null;
  since?: number;
  activity?: string;
  thinking?: boolean;
  /** Which of the ten robots is doing this turn — the chosen model's
   *  `composerStyle`. It is the one fact on this line you can read without
   *  reading: a face you already know, moving the way that model moves. */
  robot: ComposerStyle;
  /** Something started by this turn is still running behind it. It reaches the
   *  mascot's eyes rather than a dot of its own — see `BackgroundNote`. */
  background?: boolean;
  /** The waits of this turn, which its clock leaves out (`lib/turnClock`). */
  waits?: TurnWaits;
  /** The chat waits on the person: the agent is parked on a card. The line
   *  says so in the decision colour in place of what the agent is doing, the
   *  clock stops, and the companion stands still. Work the agent left
   *  running in the background is not this line's and goes on being said
   *  beside it.
   *
   *  `unknown` is the page not knowing yet whether it waits (a reload, with
   *  the lists of what waits still to be read): the clock and the companion
   *  stand as still, and the line says so in grey. It asks nothing, so it
   *  is not the decision colour, and it is not "thinking". `unchecked` is
   *  the same once the page could not read them: it says that, and
   *  `onRecheck` asks them again. */
  waiting?: ChatHold;
  onRecheck?: () => void;
}) {
  const [, tick] = useState(0);
  // The second hand runs only while there is work to count: a clock that is
  // stopped is not redrawn once a second to say the same thing.
  useEffect(() => {
    if (waiting) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  // The clock is the one figure on this line that is NOT rolled. It changes
  // every second, and a wheel that turns and then flashes takes 1.46s to do it
  // — so the line was never once still for the length of a turn, which is the
  // whole of what a reader notices about it. Rolling exists to make a change
  // findable; a change that happens every second finds itself. Tabular digits
  // keep it from nudging the words after it, which was the other half of the
  // wheel's job. The activity words keep theirs: they move rarely,
  // and rarely is exactly when the motion earns its keep.
  return (
    <>
      {/* The reply already identifies the agent; keep its activity line quiet. */}
      {!persona && <Mascot robot={robot} alert={background} mood={waiting ? "still" : thinking ? "think" : "work"} />}
      {since !== undefined && (
        <>
          <span className="working-clock">{elapsedLabel(turnElapsed(since, waits, Date.now()))}</span>
          {" · "}
        </>
      )}
      {waiting ? (
        // The stopped clock and the words, and nothing between them: how
        // much was written is not news while nothing is being written, and
        // on a phone it pushed the one thing to read off the line.
        <>
          <span className={`working-waits enter-fade${asksPerson(waiting) ? "" : " is-unknown"}`}>{WAIT_WORDS[waiting]}</span>
          {/* The page could not read its lists of what waits, so it cannot
              say whether this chat does. It does not guess: the clock
              stands, and this asks the lists again. A button with its words
              on it, never a tooltip alone. */}
          {waiting === "unchecked" && onRecheck && (
            <button type="button" className="working-recheck" onClick={onRecheck} data-icon-action aria-label={RECHECK_LABEL} title={RECHECK_LABEL}><ActionIcon name="refresh" label="Check again" /></button>
          )}
        </>
      ) : (
        <RollingText>
          {workingLine({
            activity,
            thinking,
          })}
        </RollingText>
      )}
    </>
  );
}

/** 357076 → "357k". Token counts are only ever read as a rough size. */
function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
