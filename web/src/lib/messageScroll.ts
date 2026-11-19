// Scroll math and anchors for the transcript (moved verbatim from MessageList.tsx).
import { type Anchor } from "./chatPlace";

/** How long the conversation takes to travel to a new bottom when a turn
 *  arrives, instead of jumping there.
 *
 *  Sending is ONE gesture and should look like one thing happening: the
 *  conversation slides up to open a space, and the new turn fades into the
 *  space it opened. So the bubble's fade is delayed past the start of this
 *  travel rather than run against it — see `.msg-user.is-new`, and keep the two
 *  numbers in step if either moves.
 *
 *  Only an ARRIVAL glides. A stream's height changes keep the instant pin they
 *  have always had: those come dozens a second, and easing toward a target that
 *  is replaced before the ease finishes is a rubber band, not a scroll. */
export const GLIDE_MS = 280;

/** easeOutQuint — the curve `cubic-bezier(0.22, 1, 0.36, 1)` draws, which is
 *  what every arriving thing in this app already moves on. Written out because
 *  a scroll is animated in JS and cannot name a CSS curve. */
const glideEase = (t: number) => 1 - Math.pow(1 - t, 5);

/** Where the scroller sits `p` of the way through a glide that began at `from`,
 *  given where the bottom is NOW.
 *
 *  `bottom` is passed per frame rather than captured when the glide started,
 *  and that is the whole design: the bottom MOVES while a glide runs — the
 *  reply that triggered it begins streaming, a tool card's file list lands
 *  under it, an image finishes loading. Easing toward a target measured once
 *  would land short and leave the resize observer to snap the remainder, which
 *  is the jump the glide exists to remove. Re-aimed every frame, `p === 1` is
 *  the real bottom whatever happened in between.
 *
 *  Exported for its test only; `glideToBottom` is the one caller. */
export function glideAt(from: number, bottom: number, p: number): number {
  const t = p < 0 ? 0 : p > 1 ? 1 : p;
  return from + (bottom - from) * glideEase(t);
}

/** Below this the travel is not worth animating — a one-line turn arriving into
 *  a half-empty transcript moves the bottom by a few pixels, and a 280ms
 *  animation of three pixels reads as a hesitation. */
export const GLIDE_MIN_PX = 8;

/** Asked to be spared animation. The stylesheet answers this for itself in 26
 *  places; a scroll animated in JS has to ask. Guarded because the component's
 *  tests run in node, where there is no `matchMedia`. */
export function reducedMotion() {
  if (typeof window === "undefined") return false;
  return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** How close to the bottom still counts as being AT it. One number for both
 *  questions it settles — whether to follow the stream, and whether there is a
 *  place worth remembering — because they are the same question. */
export const NEAR_BOTTOM = 80;

/** A press on the jump control is not a gesture taking the transcript away
 *  from follow mode. The control lives inside the scroller, so its pointer and
 *  touch events bubble through the same listeners that detect a reader
 *  grabbing the scrollbar. Treating that press as a manual scroll cancels the
 *  glide on its first programmatic scroll event and leaves the reader short of
 *  the end. Kept as a small predicate so mouse and touch regress together. */
export function isJumpControl(target: EventTarget | null): boolean {
  return !!(target as Element | null)?.closest?.(".jump");
}

/** How long after the reader stops moving their place is written down. Long
 *  enough that one flick is one write, short enough to be there after the
 *  reload that follows every client build. */
export const PLACE_MS = 400;

/** How long a restored place is held against a transcript that is still
 *  settling into its final height.
 *
 *  Generous, because settling is not quick on the chats that most need this:
 *  file lists arrive from the backend one turn at a time, cards measure
 *  themselves, and a transcript of a few megabytes is still laying itself out
 *  seconds after it appears. It costs nothing to be generous — the hold ends
 *  at the first thing the reader does, and while it lasts it is putting them
 *  back where they asked to be. */
export const SETTLE_MS = 6_000;

/** Where each message turn sits in the content, for `lib/chatPlace` to anchor a
 *  place to. Measured off the elements rather than the message data, for the
 *  same reason ConversationMap measures its marks that way: it stays truthful
 *  while an answer streams and cards open. Assistant turns anchor a long
 *  answer directly; the map still names only the person's user turns. */
export function anchorsIn(el: HTMLElement): Anchor[] {
  const box = el.getBoundingClientRect();
  const out: Anchor[] = [];
  for (const node of el.querySelectorAll<HTMLElement>("[data-reading-turn]")) {
    const id = node.dataset.readingTurn;
    if (id) out.push({ id, offset: el.scrollTop + node.getBoundingClientRect().top - box.top });
  }
  return out;
}
