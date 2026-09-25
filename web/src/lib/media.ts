// Is the window wide enough for the layout that needs the room?
//
// CSS answers this for STYLE, and that is where the answer belongs whenever it
// is a matter of style. It cannot answer it for PLACE: the view switch, action
// group, and live readouts move between the top bar, its overflow menu, and the
// sidebar as room appears. A media query cannot move one element between those
// parents.
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

/** The first layout breakpoint: below it the sidebar is a drawer, the right
 *  column is not a column, and primary navigation moves off the top bar. Kept in
 *  step with the `700px` media queries in styles.css. */
export const WIDE = "(min-width: 701px)";

/** Enough room for the ordinary chat actions beside centred navigation.
 *  Below this they stay behind one disclosure. This deliberately starts well
 *  above the 860px desktop-layout boundary: an 878px window can hold the three
 *  app columns, but it cannot also hold every chat action across one row. */
export const TOPBAR_ACTIONS = "(min-width: 1180px)";

/** Below this the project list occupies its own screen; at and above it,
 *  projects remain a column beside the workspace. Matches styles.css. */
export const MOBILE = "(max-width: 859.98px)";

/** Enough room to put the run's tasks BESIDE the conversation instead of
 *  behind a tab. A readable transcript wants ~600px and the task column ~360px,
 *  on top of the chat list — so below this the two stay one at a time. Kept in
 *  step with the `1180px` query in ChatWorkflowBar.css. */
export const WORKFLOW_SPLIT = "(min-width: 1181px)";
