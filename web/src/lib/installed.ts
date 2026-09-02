// "Is this a home-screen app rather than a browser tab?"
//
// Its own module, with no imports, because two very different places need the
// answer: web push (which does not exist for an iOS tab) and the top bar's
// reload (which a tab does not need, having one of its own). It used to live
// in `push.ts`, and importing it from a component pulled the whole socket
// bridge in behind it — `bridge.ts` opens a connection at module load, so a
// button could not be rendered without one.

/** The display modes that mean "installed". Asking only about `standalone` is
 *  the bug that hides here: `minimal-ui` is equally installed, and in that mode
 *  the `standalone` query is FALSE — a phone with the app on its home screen
 *  would be told to go and add the app to its home screen. */
const INSTALLED_MODES = ["standalone", "minimal-ui", "fullscreen"];

export function installed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return (
      INSTALLED_MODES.some(
        (mode) => window.matchMedia?.(`(display-mode: ${mode})`).matches === true,
      ) ||
      // iOS's own, older flag; still the only true answer on some versions.
      (navigator as { standalone?: boolean }).standalone === true
    );
  } catch {
    // `matchMedia` is absent in a test environment and in an SSR pass. An
    // unavailable answer means "a normal tab", which is the safe default: the
    // reload button stays away, and push says "not installed yet".
    return false;
  }
}
