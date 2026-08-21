// Is the window wide enough for the layout that needs the room?
//
// CSS answers this for STYLE, and that is where the answer belongs whenever it
// is a matter of style. It cannot answer it for PLACE: the view switch and the
// plan-usage meter live in the top bar on a wide screen and inside the drawer
// on a phone, and no media query moves an element from one parent to another.
//
// Rendering both and hiding one would be the other way, and it is worse here:
// the usage meter polls an endpoint that rate-limits per account, so a second
// copy of it is a second copy of the traffic — hidden or not.
import { useEffect, useState } from "react";

/** True while the query matches, and updated when that changes. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    // Set once on subscribe: the window can have been resized between the first
    // render and this effect, and a stale answer here puts a control in the
    // wrong place until something else happens to re-render.
    setMatches(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** The one breakpoint the app turns on: below it the sidebar is a drawer, the
 *  right column is not a column, and the top bar has room for four things.
 *  Kept in step with the `700px` media queries in styles.css. */
export const WIDE = "(min-width: 701px)";
