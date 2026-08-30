// The page, filling the display.
//
// A wide screen is mostly browser at the top — tabs, a URL bar, a bookmarks
// row — and none of it is anything to do with the work. The Fullscreen API
// takes all three away and hands the app the whole panel, which is the state
// this thing is worth having in.
//
// Four traps, and this module exists for them:
//
//   · The state is NOT what this module last did. Escape leaves fullscreen
//     without going through here at all, and so does the browser's own F11.
//     A button that remembered its last press would sit there offering to
//     "exit" a window that is already back to normal. So nothing is
//     remembered — `isFullscreen` asks the document, and `subscribe` re-asks
//     it every time the browser says it changed.
//   · Safari still has only the `webkit` names, and `webkitRequestFullscreen`
//     returns UNDEFINED rather than a promise, so nothing may `.catch()` what
//     it hands back without wrapping it first.
//   · `requestFullscreen` REJECTS when it was not called from a real gesture,
//     or when the embedding page forbids it. That is not worth throwing for —
//     the window simply stays the size it was — so the promise is answered
//     with a boolean and never rethrown.
//   · iOS Safari has no fullscreen for anything that is not a video, and says
//     so through `fullscreenEnabled: false`. `canFullscreen` is what the top
//     bar asks BEFORE it draws the button, because a control that is present
//     and does nothing is worse than one that was never offered.
//
// The DOM is reached through the two duck types below rather than through the
// globals directly, so all of this can be tested in node — vitest here runs
// with no jsdom, and `document` does not exist at all.
import { useEffect, useState } from "react";

/** The handful of things this module reads off `document`. Every field is
 *  optional: a browser that has none of them is exactly the case being
 *  handled, and on Safari half of them are the `webkit` half. */
export type FsDoc = {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => Promise<void> | void;
};

/** The element being asked to fill the screen — in practice `<html>`, so that
 *  the app's own background paints the whole panel rather than leaving the
 *  browser's white behind a shorter page. */
export type FsElement = {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: () => Promise<void> | void;
};

/** Both spellings of the "it changed" event. Subscribing to both is safe: no
 *  browser fires both, and one it does not know is one it never emits. */
export const FS_EVENTS = ["fullscreenchange", "webkitfullscreenchange"] as const;

/** `document`, when there is one. Read through a function rather than saved at
 *  import time so this module can be imported into a node test. */
function theDoc(): FsDoc | null {
  return typeof document === "undefined" ? null : (document as unknown as FsDoc);
}

function theElement(): FsElement | null {
  return typeof document === "undefined"
    ? null
    : (document.documentElement as unknown as FsElement);
}

/** Whether something is filling the screen right now.
 *
 *  The question is deliberately "is anything", not "is OUR element": the image
 *  viewer could one day put a picture up on its own, and while it is up the
 *  page is fullscreen by any reading a person would give the word. */
export function isFullscreen(doc: FsDoc | null = theDoc()): boolean {
  if (!doc) return false;
  return Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);
}

/** Whether this browser will do it at all — asked before the control is drawn.
 *
 *  Both halves have to be there. Chrome in an iframe without `allow-fullscreen`
 *  keeps the method and turns `fullscreenEnabled` off, and iOS Safari on the
 *  phone keeps neither. */
export function canFullscreen(
  doc: FsDoc | null = theDoc(),
  el: FsElement | null = theElement(),
): boolean {
  if (!doc || !el) return false;
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? false;
  const asks = Boolean(el.requestFullscreen ?? el.webkitRequestFullscreen);
  return enabled && asks;
}

/** Run whichever of a pair of methods this browser has, and answer whether it
 *  went through. Never throws: see the third trap at the top. */
async function attempt(run: (() => Promise<void> | void) | undefined): Promise<boolean> {
  if (!run) return false;
  try {
    // `await` on a plain `undefined` is fine, which is what makes this cover
    // Safari's non-promise `webkit` spelling as well as the standard one.
    await run();
    return true;
  } catch {
    // No gesture, or the browser said no. The window stays as it was, and the
    // caller finds out the same way it finds out about Escape — from the
    // change event, which in this case never comes.
    return false;
  }
}

/** Fill the screen. Must be called from a click or a key press. */
export function enter(el: FsElement | null = theElement()): Promise<boolean> {
  if (!el) return Promise.resolve(false);
  const ask = el.requestFullscreen ?? el.webkitRequestFullscreen;
  // Bound back to the element: pulled off it, `this` is gone and Chrome throws
  // an "Illegal invocation" rather than a rejection.
  return attempt(ask && (() => ask.call(el)));
}

/** Give the screen back. */
export function exit(doc: FsDoc | null = theDoc()): Promise<boolean> {
  if (!doc) return Promise.resolve(false);
  const ask = doc.exitFullscreen ?? doc.webkitExitFullscreen;
  return attempt(ask && (() => ask.call(doc)));
}

/** The one a button calls: whichever of the two the current state asks for. */
export function toggle(
  doc: FsDoc | null = theDoc(),
  el: FsElement | null = theElement(),
): Promise<boolean> {
  return isFullscreen(doc) ? exit(doc) : enter(el);
}

/** True while the page is filling the screen, and kept true to the browser
 *  rather than to what was last pressed.
 *
 *  The initial value is read in a lazy initialiser rather than in an effect, so
 *  a component that mounts while ALREADY fullscreen — a reload from inside it,
 *  which Chrome keeps — draws the right icon on its first paint instead of
 *  flipping one frame later. */
export function useFullscreen(): boolean {
  const [on, setOn] = useState(isFullscreen);

  useEffect(() => {
    const sync = () => setOn(isFullscreen());
    // Re-read once on subscribe for the same reason `useMedia` does: the state
    // can have changed between the first render and this effect.
    sync();
    for (const name of FS_EVENTS) document.addEventListener(name, sync);
    return () => {
      for (const name of FS_EVENTS) document.removeEventListener(name, sync);
    };
  }, []);

  return on;
}
