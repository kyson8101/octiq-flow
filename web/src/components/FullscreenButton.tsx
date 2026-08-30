// The switch that hands the app the whole display.
//
// On a wide screen the top hundred pixels of the window are tabs, a URL bar and
// a bookmarks row, none of which have anything to do with the work; on a 34"
// panel that is a strip of browser the width of a desk. This takes them away.
//
// Two things it deliberately does NOT do:
//
//   · It does not remember. Fullscreen is a mode you are in, not a preference
//     you hold — the browser drops it on Escape, on F11 and on some tab
//     switches, and a page that let itself back in on the next load would be
//     taking the display without being asked. `useFullscreen` reads the state
//     off the document every time for the same reason.
//   · It does not draw itself where it cannot work. iOS Safari has no
//     fullscreen for anything that is not a video, and a control that is
//     present and does nothing is worse than one that was never offered.
//
// See lib/fullscreen for the browser differences underneath.
import { canFullscreen, toggle, useFullscreen } from "../lib/fullscreen";

export function FullscreenButton() {
  // Before the early return: a hook may not sit behind a condition, and the
  // condition here is about the browser rather than about this render.
  const on = useFullscreen();

  if (!canFullscreen()) return null;

  return (
    <button
      className={`icon-btn fs-toggle ${on ? "is-on" : ""}`}
      type="button"
      // `aria-pressed`, not `aria-expanded`: this is a switch that stays down,
      // not a disclosure that reveals something beneath it.
      aria-pressed={on}
      aria-label={on ? "Leave full screen" : "Full screen"}
      title={on ? "Leave full screen (Esc)" : "Full screen"}
      // The click IS the gesture the browser requires. Anything that deferred
      // this — a confirm, an await before it — would have the request refused.
      onClick={() => void toggle()}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* Both arrow sets are always in the DOM and one is faded out, so the
            swap is a cross-fade rather than a replacement that pops. */}
        <g className="fs-arrows fs-arrows-in">
          <path d="M8 3H5a2 2 0 0 0-2 2v3" />
          <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
          <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
          <path d="M3 16v3a2 2 0 0 0 2 2h3" />
        </g>
        <g className="fs-arrows fs-arrows-out">
          <path d="M8 3v3a2 2 0 0 1-2 2H3" />
          <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
          <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
          <path d="M3 16h3a2 2 0 0 1 2 2v3" />
        </g>
      </svg>
    </button>
  );
}
