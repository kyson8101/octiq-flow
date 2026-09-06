import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { EDGE_PX, scrollsSideways } from "../lib/swipe";
import { queuedSwipeEnd, queuedSwipeMove, queuedSwipeOffset, queuedSwipeStart, type QueuedSwipe } from "../lib/queuedSwipe";
import "./MessageBubble.css";

const MOBILE_ACTIONS = "(max-width: 700px), (pointer: coarse)";
const ACTION_WIDTH = 80;
const INTERACTIVE = "button, a, input, textarea, select, [contenteditable], [data-noswipe]";

/** The user bubble keeps its wrapper after pickup, so queue state never adds
 *  a row or remounts its text/attachments. Desktop keeps the inline controls. */
export function MessageBubble({
  user,
  turnId,
  onStart,
  onCancel,
  children,
}: {
  user: boolean;
  turnId?: string;
  onStart?: () => void;
  onCancel?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const ignoreClickUntil = useRef(0);
  const panelId = useId();
  const actionable = user && !!turnId && !!(onStart || onCancel);
  const width = (Number(!!onStart) + Number(!!onCancel)) * ACTION_WIDTH;
  const expanded = actionable && open;

  function changeOpen(next: boolean) {
    openRef.current = next;
    setOpen(next);
  }

  useEffect(() => {
    changeOpen(false);
    const el = root.current;
    if (!el || !actionable) return;
    const media = window.matchMedia(MOBILE_ACTIONS);
    let swipe: QueuedSwipe | null = null;

    const clear = () => {
      swipe = null;
      delete el.dataset.swiping;
      el.style.removeProperty("--queue-reveal");
    };
    const start = (event: TouchEvent) => {
      clear();
      ignoreClickUntil.current = 0;
      if (!media.matches || event.touches.length !== 1) return;
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;
      const target = event.target instanceof Element ? event.target : null;
      // The wrapper itself opts out of chat switching; only nested controls
      // and independently scrollable content opt out of this gesture.
      const interactive = target?.closest(INTERACTIVE);
      if (interactive && interactive !== el) return;
      if (scrollsSideways(target, el)) return;
      const touch = event.touches[0];
      if (touch.clientX <= EDGE_PX || touch.clientX >= window.innerWidth - EDGE_PX) return;
      swipe = queuedSwipeStart({ x: touch.clientX, y: touch.clientY, t: event.timeStamp }, width, openRef.current);
    };
    const move = (event: TouchEvent) => {
      if (!swipe) return;
      if (event.touches.length !== 1) return clear();
      const touch = event.touches[0];
      swipe = queuedSwipeMove(swipe, { x: touch.clientX, y: touch.clientY, t: event.timeStamp });
      if (swipe.phase === "dropped") return clear();
      if (swipe.phase !== "swiping") return;
      if (!event.cancelable) return clear();
      event.preventDefault();
      ignoreClickUntil.current = Date.now() + 500;
      el.dataset.swiping = "true";
      el.style.setProperty("--queue-reveal", `${queuedSwipeOffset(swipe)}px`);
    };
    const end = (event: TouchEvent) => {
      if (swipe) changeOpen(queuedSwipeEnd(swipe, event.timeStamp));
      clear();
    };
    const resize = () => {
      clear();
      if (!media.matches) changeOpen(false);
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end, { passive: true });
    el.addEventListener("touchcancel", clear, { passive: true });
    media.addEventListener("change", resize);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", clear);
      media.removeEventListener("change", resize);
      clear();
    };
  }, [actionable, turnId, width]);

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) changeOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);

  const body = (
    <div className="msg-body">
      {children}
      {actionable && (
        <button
          ref={trigger}
          type="button"
          className="queue-actions-toggle"
          aria-label="Queued message actions"
          aria-expanded={expanded}
          aria-controls={panelId}
          title="Queued — swipe left or tap for actions"
          onClick={() => changeOpen(!open)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.8" />
            <circle cx="12" cy="12" r="1.8" />
            <circle cx="19" cy="12" r="1.8" />
          </svg>
        </button>
      )}
    </div>
  );
  if (!user) return body;
  return (
    <div
      ref={root}
      className="queue-swipe"
      data-noswipe={actionable ? "" : undefined}
      data-actionable={actionable || undefined}
      data-open={expanded || undefined}
      style={{ "--queue-actions-width": `${width}px` } as CSSProperties}
      onClickCapture={(event) => {
        if (event.detail && Date.now() < ignoreClickUntil.current) {
          event.preventDefault();
          event.stopPropagation();
          ignoreClickUntil.current = 0;
        }
      }}
      onClick={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (expanded && !target?.closest("button, a")) changeOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !expanded) return;
        event.preventDefault();
        event.stopPropagation();
        changeOpen(false);
        trigger.current?.focus();
      }}
    >
      {body}
      {actionable && (
        <div
          id={panelId}
          className="queue-action-tray"
          role="group"
          aria-label="Queued message actions"
          aria-hidden={!expanded}
          inert={!expanded}
        >
          {onStart && (
            <button
              type="button"
              className="queue-action-start"
              aria-label="Send this queued message now"
              title="Stop the current turn and send this queued message now"
              onClick={() => { changeOpen(false); onStart(); }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14m-6-6 6 6-6 6" />
              </svg>
              <span>Send now</span>
            </button>
          )}
          {onCancel && (
            <button
              type="button"
              className="queue-action-cancel"
              aria-label="Take this queued message back to edit"
              onClick={() => { changeOpen(false); onCancel(); }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m9 4-5 5 5 5M4 9h10a6 6 0 0 1 0 12" />
              </svg>
              <span>Take back</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
