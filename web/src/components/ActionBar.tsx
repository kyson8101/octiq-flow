// The row of actions under the top bar: every action for what is on screen,
// each a button with an icon and a short label, in one line.
//
// The top bar above it names the page and nothing else. A title can run to
// two lines there, and the actions used to be squeezed against it, most of
// them behind one "…" menu.
//
// Two shapes, by the same 860px that decides phone against desktop:
//
//   * A desktop measures. What does not fit goes behind More, the lowest
//     `keep` first, and whatever waits on the person behind More is counted
//     on More itself.
//   * A phone scrolls sideways. Nothing wraps and nothing is put away; a fade
//     marks the edge that is cut.
//
// Its height is fixed from the first paint and it is drawn before its buttons
// are known (`reserved`), so a button or a count that arrives never moves the
// page.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cutEdges, overflowing } from "../lib/actionBar";
import { TopbarActionsMenu } from "./TopbarActionsMenu";
import "./ActionBar.css";

/** One action of the bar. Adding a button to the bar is adding one of these. */
export type BarAction = {
  id: string;
  /** How long it stays in the row as the bar narrows: the lowest goes behind
   *  More first. */
  keep: number;
  /** How many things wait on the person behind this button, counted on More
   *  while the button is in there. */
  attention?: number;
  /** A rule before it: what follows is of another kind (the destructive end). */
  separated?: boolean;
  node: ReactNode;
};

/** What More takes in the row before it has been drawn once; after that it
 *  is measured like every button (a wider font makes a wider More). */
const MORE_WIDTH = 68;
const NONE: readonly string[] = [];

export function ActionBar({
  actions,
  scrolls,
  reserved = false,
  lead,
  end,
  className = "",
  initiallyOver = NONE,
  initiallyOpen = false,
}: {
  actions: readonly BarAction[];
  /** A phone: the row scrolls sideways instead of putting buttons away. */
  scrolls: boolean;
  /** Draw the bar even with nothing in it yet: this page has actions once
   *  its facts arrive, and the bar must already be there when they do. */
  reserved?: boolean;
  /** A page's own buttons, ahead of the actions (WorkspaceHeader's slot). */
  lead?: ReactNode;
  /** What stays at the far end whatever the row does (a phone's usage). */
  end?: ReactNode;
  className?: string;
  /** Static-render seams for the bar's test: there is no layout to measure. */
  initiallyOver?: readonly string[];
  initiallyOpen?: boolean;
}) {
  const row = useRef<HTMLDivElement>(null);
  const widths = useRef(new Map<string, number>());
  const moreWidth = useRef(MORE_WIDTH);
  const latest = useRef(actions);
  latest.current = actions;
  const [over, setOver] = useState<readonly string[]>(initiallyOver);
  const ids = actions.map((action) => action.id).join(" ");

  const measure = useCallback(() => {
    const element = row.current;
    if (!element) return;
    if (scrolls) {
      const cut = cutEdges(element.scrollLeft, element.scrollWidth, element.clientWidth);
      const wrap = element.parentElement;
      if (wrap && wrap.dataset.cut !== cut) wrap.dataset.cut = cut;
      return;
    }
    // A button behind More is not in the row to be measured: what it was
    // when it left is what decides whether it has room to come back.
    for (const item of element.querySelectorAll<HTMLElement>(":scope > .actionbar-item")) {
      widths.current.set(item.dataset.action ?? "", Math.ceil(item.getBoundingClientRect().width));
    }
    const menu = element.querySelector<HTMLElement>(":scope > .mobile-actions");
    if (menu) moreWidth.current = Math.ceil(menu.getBoundingClientRect().width);
    const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
    const next = overflowing(
      latest.current.map((action) => ({ id: action.id, keep: action.keep, width: widths.current.get(action.id) ?? 0 })),
      Math.floor(element.clientWidth), gap, moreWidth.current,
    );
    setOver((before) => (before.join(" ") === next.join(" ") ? before : next));
  }, [scrolls]);

  // Before the first paint and whenever the set of buttons changes; after
  // that only when a size does (a count arrives, the window is resized).
  // Never on every render: this reads layout, and the page above renders on
  // every line an agent says.
  useLayoutEffect(() => {
    measure();
    const element = row.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const item of element.querySelectorAll(":scope > .actionbar-item")) observer.observe(item);
    return () => observer.disconnect();
  }, [measure, ids, over]);

  useEffect(() => {
    if (scrolls) setOver(NONE);
  }, [scrolls]);

  const hidden = scrolls ? NONE : over;
  const shown = actions.filter((action) => !hidden.includes(action.id));
  const more = actions.filter((action) => hidden.includes(action.id));
  const attention = more.reduce((sum, action) => sum + (action.attention ?? 0), 0);

  return (
    <div className={`actionbar${scrolls ? " is-scrolling" : ""}${reserved ? " is-held" : ""}${className ? ` ${className}` : ""}`}
      role="group" aria-label="Actions">
      {lead}
      <div className="actionbar-scroll">
        <div className="actionbar-row" ref={row} onScroll={scrolls ? measure : undefined}>
          {shown.map((action) => (
            <span key={action.id} className={`actionbar-item${action.separated ? " is-separated" : ""}`} data-action={action.id}>
              {action.node}
            </span>
          ))}
          {more.length > 0 && (
            <TopbarActionsMenu attentionCount={attention} initiallyOpen={initiallyOpen}>
              {more.map((action) => (
                <ActionInMenu key={action.id} action={action} />
              ))}
            </TopbarActionsMenu>
          )}
        </div>
      </div>
      {end}
    </div>
  );
}

function ActionInMenu({ action }: { action: BarAction }) {
  return <>
    {action.separated && <span className="topbar-actions-separator" role="separator" />}
    {action.node}
  </>;
}
