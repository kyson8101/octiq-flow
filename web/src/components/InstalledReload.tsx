// Reload, for a window that has no browser chrome to offer it.
//
// Added to a home screen the app runs `standalone`: no address bar, and no
// navigation controls either. That is the right trade for the screen space —
// but it takes away the one control this app genuinely needs, because it is a
// live view of a machine at the end of a tunnel and the honest answer to a
// socket that has gone quiet has always been to reload the page.
//
// `minimal-ui` is the display mode that keeps the native controls, and it was
// tried first; iOS did not give them. So the button lives here instead, where
// it can be tested.
//
// There is no BACK button beside it on purpose. `syncHash` in App.tsx uses
// `replaceState` deliberately, so switching chats never pushes a history
// entry and there is only ever one: back would have nowhere to go and would
// simply drop the reader out of the app.
import { useState } from "react";
// Straight from `lib/installed`, NOT from `lib/push` which re-exports it:
// `push.ts` reaches the socket bridge, and `bridge.ts` opens a connection at
// module load, so importing it here would make this button unrenderable
// without one.
import { installed } from "../lib/installed";

export function InstalledReload({
  /** Test seam. Left alone in the app, where the real question is asked. */
  show,
  onReload = () => location.reload(),
}: {
  show?: boolean;
  onReload?: () => void;
} = {}) {
  // Read once — a window does not change display mode while it is open, and
  // re-reading on every render would ask the browser to match a media query
  // for an answer that cannot have moved.
  const [visible] = useState(() => show ?? installed());
  const [spinning, setSpinning] = useState(false);

  if (!visible) return null;

  return (
    <button
      className={`icon-btn installed-reload ${spinning ? "is-spinning" : ""}`}
      type="button"
      aria-label="Reload"
      title="Reload"
      onClick={() => {
        // The spin is not decoration and not a fake progress bar: tearing the
        // page down takes a moment on a phone over a tunnel, and without it a
        // press reads as having done nothing. It is never cleared — the reload
        // takes the whole document with it.
        setSpinning(true);
        onReload();
      }}
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
        <path d="M20 11a8 8 0 1 0-.6 4" />
        <path d="M20 4v6h-6" />
      </svg>
    </button>
  );
}
