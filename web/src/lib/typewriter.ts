// Smooth out a stream that arrives in lumps.
//
// The agent sends `text_delta` events of whatever size the model produced —
// sometimes a word, sometimes a whole paragraph, arriving in bursts. Rendering
// each one as it lands makes the reply appear in visible jumps.
//
// So the deltas are treated as a BUFFER rather than as frames: the text we have
// received is the target, and what is on screen walks towards it.
//
// The pace is set by TIME, not by how much is waiting. An earlier version
// revealed a fraction of the backlog each frame, which drained every burst in a
// few frames and then sat idle until the next one — fast, then still, then
// fast: the stutter this was meant to remove. Now it runs at a steady
// characters-per-second that only rises when the backlog demands it, so the
// text keeps flowing right up to the moment the next delta lands.
import { useEffect, useRef, useState } from "react";

/** Resting pace, characters per second. Roughly brisk-typing speed: slow
 *  enough to read along with, fast enough not to feel held back. */
const BASE_CPS = 42;
/** When more is waiting than the base pace can clear, aim to catch up over
 *  this many seconds rather than immediately. Bigger = calmer under a burst. */
const DRAIN_SECONDS = 2.5;
/** Ceiling, so a very large backlog still looks like typing and not a flash. */
const MAX_CPS = 320;
/** Past this much waiting, the animation has stopped being an animation and
 *  become a delay: skip most of it and type out the tail. */
const MAX_LAG = 1500;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Reveal `target` at a readable pace while it grows.
 *
 * `active` means the agent is still writing this block. It does NOT mean "keep
 * animating": when the stream ends mid-reveal the animation carries on to the
 * end, because dumping the tail the instant the last delta arrives puts the
 * jump back at the end of every message.
 */
export function useTypewriter(target: string, active: boolean): string {
  const [shown, setShown] = useState(() => (active ? 0 : target.length));
  const shownRef = useRef(shown);
  // Fractional characters carried between frames. At the resting pace a frame
  // is worth about 0.7 of a character, so without this nothing would ever move.
  const carry = useRef(0);
  const lastAt = useRef(0);
  const frame = useRef(0);
  // Whether this block has ever been animated. A conversation loaded already
  // finished must appear whole — only text we watched arrive gets typed out.
  const started = useRef(active);

  shownRef.current = shown;
  if (active) started.current = true;

  useEffect(() => {
    if (prefersReducedMotion() || !started.current) {
      if (shownRef.current !== target.length) setShown(target.length);
      return;
    }
    // A shorter target means the slot was reused by a new message.
    if (shownRef.current > target.length) {
      setShown(target.length);
      return;
    }

    const tick = (now: number) => {
      const remaining = target.length - shownRef.current;
      if (remaining <= 0) {
        lastAt.current = 0;
        carry.current = 0;
        return; // caught up; the next delta restarts the loop
      }

      // First frame of a run has no interval to measure from.
      const dt = lastAt.current ? Math.min(now - lastAt.current, 100) : 16;
      lastAt.current = now;

      if (remaining > MAX_LAG) {
        shownRef.current = target.length - MAX_LAG;
        setShown(shownRef.current);
        frame.current = requestAnimationFrame(tick);
        return;
      }

      // Steady pace, raised only as far as the backlog requires.
      const cps = Math.min(MAX_CPS, Math.max(BASE_CPS, remaining / DRAIN_SECONDS));
      carry.current += (cps * dt) / 1000;
      const step = Math.floor(carry.current);
      if (step >= 1) {
        carry.current -= step;
        shownRef.current = Math.min(target.length, shownRef.current + step);
        setShown(shownRef.current);
      }
      frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [target, active]);

  return target.slice(0, shown);
}
