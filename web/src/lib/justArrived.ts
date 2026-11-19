// The turns that arrived, as opposed to the ones already there (moved verbatim from MessageList.tsx).
import { useRef } from "react";
import type { Message } from "./chat";

/** The turns that ARRIVED, as opposed to the ones that were already there.
 *
 *  A message you just sent should come in rather than blink into being, and
 *  every other way a turn reaches the screen should not. Opening a chat mounts
 *  its whole transcript in one frame, and thirty bubbles rising together is not
 *  an arrival, it is a stampede — the same for switching to a chat, and for a
 *  resume that lands several turns at once.
 *
 *  So the test is deliberately narrow: exactly one turn appended to the end of
 *  what was already on screen. That is what sending is, and what an agent's
 *  reply is, and it is nothing else. A whole list being replaced fails it, and
 *  the cost of failing it is that something does not animate — never that
 *  everything does.
 *
 *  Marked once and marked for good. The class has to outlive the re-renders
 *  streaming causes, because an animation cut off two frames in looks worse
 *  than none at all, and leaving it on costs nothing: an animation runs when it
 *  is applied to an element, and the turn keeps the same DOM node.
 *
 *  The ref is written during the render, which StrictMode's double pass handles
 *  by itself — the second pass sees the list it just recorded, is not one turn
 *  longer than it, and marks nothing.
 *
 *  `nth` counts the arrivals rather than naming the last one, because it is
 *  read as an effect's dependency and an id is not enough to fire on: the same
 *  turn can be the newest across many renders. A count read from a ref also
 *  survives StrictMode's second pass — that pass marks nothing, so it returns
 *  the number the first one reached rather than resetting it.
 */
export function useJustArrived(turns: Message[][]) {
  const before = useRef<string[] | null>(null);
  const fresh = useRef<Set<string>>(new Set());
  const nth = useRef(0);

  const ids = turns.map((t) => t[0].id);
  const was = before.current;
  before.current = ids;

  const arrived = justAppended(was, ids);
  if (arrived) {
    fresh.current.add(arrived);
    nth.current++;
  }
  return { fresh: fresh.current, nth: nth.current };
}

/** The single turn appended to the end of `was`, or null when `ids` is anything
 *  else at all: a different list, the same list, several at once, or the first
 *  draw, which has nothing to be different from.
 *
 *  Separated out and exported for its test — `useJustArrived` is the only
 *  caller. The rule is one line but the cases it has to refuse are not. */
export function justAppended(was: string[] | null, ids: string[]): string | null {
  if (!was || ids.length !== was.length + 1) return null;
  for (let i = 0; i < was.length; i++) if (was[i] !== ids[i]) return null;
  return ids[ids.length - 1];
}
