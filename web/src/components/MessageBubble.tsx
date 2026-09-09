import type { ReactNode } from "react";
import "./MessageBubble.css";

/** Keep the bubble stable after pickup. Mobile queue actions have explicit
 * touch targets below the text; desktop uses the inline controls. */
export function MessageBubble({ user, turnId, onStart, onCancel, children }: {
  user: boolean;
  turnId?: string;
  onStart?: () => void;
  onCancel?: () => void;
  children: ReactNode;
}) {
  const actionable = user && !!turnId && !!(onStart || onCancel);
  const body = (
    <div className="msg-body">
      {children}
    </div>
  );
  if (!user) return body;
  return (
    <div className="queue-swipe" data-noswipe={actionable ? "" : undefined} data-actionable={actionable || undefined}>
      {body}
      {actionable && (
        <div
          className="queue-action-tray"
          role="group"
          aria-label="Queued message actions"
        >
          {onStart && (
            <button
              type="button"
              className="queue-action-start"
              aria-label="Send this queued message now"
              title="Stop the current turn and send this queued message now"
              onClick={onStart}
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
              onClick={onCancel}
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
