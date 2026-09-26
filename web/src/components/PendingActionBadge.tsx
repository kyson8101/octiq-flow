// "Plan approval", "Permission needed", "Action needed · 3": what a chat row or
// a task row is waiting on you for, and the way straight to it.
//
// A button of its own, beside the row's button rather than inside it, so the
// row still opens its chat the ordinary way and this one goes to the card.
// Going there only shows the card: nothing is approved, answered or
// dismissed by looking.
import { createContext, useContext } from "react";
import { pendingDescription, pendingLabel, pendingSelector, type PendingAction } from "../lib/pendingActions";
import "./PendingActionBadge.css";

export type PendingActionsView = {
  forRow: (chatId: string) => readonly PendingAction[];
  forTask: (taskId: string) => readonly PendingAction[];
  /** Open the conversation, run and task holding the card, and show it. */
  reveal: (action: PendingAction) => void;
};

const NONE: readonly PendingAction[] = [];
export const NO_PENDING_ACTIONS: PendingActionsView = { forRow: () => NONE, forTask: () => NONE, reveal: () => {} };
export const PendingActionsContext = createContext<PendingActionsView>(NO_PENDING_ACTIONS);

export function usePendingActions(): PendingActionsView {
  return useContext(PendingActionsContext);
}

export function PendingActionBadge({ actions, subject, className = "" }: {
  actions: readonly PendingAction[];
  /** What the actions belong to, for the button's name: a chat or task title. */
  subject: string;
  className?: string;
}) {
  const { reveal } = usePendingActions();
  if (actions.length === 0) return null;
  const label = pendingLabel(actions);
  const description = pendingDescription(actions);
  const several = actions.length > 1;
  return (
    <button type="button" className={`pending-action-badge${className ? ` ${className}` : ""}`}
      data-kind={several ? "several" : actions[0].kind}
      aria-label={`${label} for ${subject}: ${description}. Show ${several ? "the first one" : "it"}`}
      title={`${description}. Click to show ${several ? "the first one" : "it"}.`}
      onClick={(event) => {
        event.stopPropagation();
        reveal(actions[0]);
      }}>
      <AlertIcon />
      <span className="pending-action-text">{label}</span>
    </button>
  );
}

/** Find the on-screen card answering `key`, scroll it to the middle and
 *  focus it, so a keyboard continues from there. False while it is not drawn
 *  (a transcript still loading, a panel still opening). Never presses
 *  anything on the card. */
export function showPendingCard(key: string, root: ParentNode = document): boolean {
  const target = [...root.querySelectorAll<HTMLElement>(pendingSelector(key))]
    .map((element) => element.classList.contains("pending-target") ? element.firstElementChild as HTMLElement | null : element)
    .find((element): element is HTMLElement => !!element && element.getClientRects().length > 0);
  if (!target) return false;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView?.({ block: "center", behavior: still ? "auto" : "smooth" });
  if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: true });
  target.classList.remove("pending-revealed");
  void target.offsetWidth; // restart the ring when it is asked for twice
  target.classList.add("pending-revealed");
  window.setTimeout(() => target.classList.remove("pending-revealed"), 1700);
  return true;
}

function AlertIcon() {
  return (
    <svg className="pending-action-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.5h.01" />
    </svg>
  );
}
