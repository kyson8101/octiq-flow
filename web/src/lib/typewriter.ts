// Smooth out a stream that arrives in lumps.
//
// The agent sends `text_delta` events of whatever size the model produced —
// sometimes a word, sometimes a whole paragraph, arriving in bursts. Rendering
// each one as it lands makes the reply appear in visible jumps.
//
// So the deltas are treated as a BUFFER rather than as frames: the text we have
// received is the target, and what is on screen walks towards it a few
// characters per animation frame. The rate is proportional to how far behind we
// are, which means:
//
//   · a trickle of text reveals at a steady, readable pace
//   · a burst catches up quickly instead of crawling for seconds
//   · nothing is ever lost — the target only grows, and we always reach it
//
// When the message finishes the remaining text is released at once: an animation
// still playing after the agent has stopped talking is just a delay.
import { useEffect, useRef, useState } from "react";

/** Fraction of the backlog to clear each frame. Smaller = smoother and slower. */
const CATCH_UP = 1 / 6;
/** Never reveal fewer than this per frame, or a long tail crawls. */
const MIN_STEP = 1;
/** Never reveal more than this per frame, or a burst defeats the point. */
const MAX_STEP = 60;
/** Past this backlog the animation stops being an animation and becomes a wait,
 *  so we jump most of the way and animate only the tail. */
const MAX_LAG = 1200;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Reveal `target` progressively while `active`, all at once when not.
 *
 * Returns the substring to render right now. The caller re-renders on every
 * frame of the animation, which is what a growing message does anyway.
 */
export function useTypewriter(target: string, active: boolean): string {
  const [shown, setShown] = useState(() => (active ? 0 : target.length));
  const shownRef = useRef(shown);
  const frame = useRef(0);

  // Keep the ref in step so the animation loop reads the current value without
  // being restarted by it.
  shownRef.current = shown;

  useEffect(() => {
    // Finished, or the user asked for no motion: show everything.
    if (!active || prefersReducedMotion()) {
      if (shownRef.current !== target.length) setShown(target.length);
      return;
    }
    // The message was replaced by a shorter one (a new turn reusing the slot).
    if (shownRef.current > target.length) {
      setShown(target.length);
      return;
    }

    const tick = () => {
      const remaining = target.length - shownRef.current;
      if (remaining <= 0) return; // caught up; the next delta restarts us

      let next: number;
      if (remaining > MAX_LAG) {
        next = target.length - MAX_LAG;
      } else {
        const step = Math.min(MAX_STEP, Math.max(MIN_STEP, Math.ceil(remaining * CATCH_UP)));
        next = shownRef.current + step;
      }
      shownRef.current = next;
      setShown(next);
      frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [target, active]);

  return target.slice(0, shown);
}

/**
 * Make a half-written markdown string safe to render.
 *
 * Revealing text a few characters at a time means the parser regularly sees a
 * code fence that has opened and not closed, and renders the rest of the reply
 * as code until the closing fence arrives — the block flickers in and out as it
 * streams. Closing the fence ourselves keeps it stable; the real closer simply
 * replaces this one a moment later.
 */
export function closeOpenFences(text: string): string {
  const fences = (text.match(/^```/gm) ?? []).length;
  if (fences % 2 === 0) return text;
  return text.endsWith("\n") ? `${text}\`\`\`` : `${text}\n\`\`\``;
}
