import type { ReactNode } from "react";
import type { Message } from "../lib/chat";
import "./MessageBubble.css";

/** One visible delivery row on every screen size. Its height is retained when
 * the queue controls become a delivery receipt, so pickup doesn't move prose. */
export function MessageBubble({ user, message, wrapUp = false, onStart, onCancel, onRestore, onDismiss, footer, children }: {
  user: boolean;
  message: Message;
  /** The host's wrap-up turn of a completion (`lib/chatComplete`): taking it
   *  back cancels the completion, and there are no words to return. */
  wrapUp?: boolean;
  onStart?: () => void;
  onCancel?: () => void;
  onRestore?: () => void;
  onDismiss?: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const body = <div className="msg-body">{children}</div>;
  if (!user) return body;
  const accepted = !!(message.echo || message.takenUp);
  const delivery = accepted ? "dispatched" : message.queueLost ? "failed" : message.delivery;
  const pending = !!message.queueAction;
  const label = message.queueAction === "cancel" ? (wrapUp ? "Cancelling…" : "Returning to composer…")
    : message.queueAction === "start" || delivery === "starting" ? "Sending next…"
    : accepted ? "Sent"
    : delivery === "queued" ? "Queued"
    : delivery === "sending" ? "Sending…"
    : delivery === "dispatched" ? "Awaiting agent confirmation"
    : delivery === "failed" ? "Not sent"
    : message.turnId ? "Delivery unconfirmed" : undefined;
  const detail = delivery === "queued" ? "Runs after the current reply. Send now stops that reply."
    : delivery === "dispatched" && !accepted ? "The message was handed off, but the agent has not confirmed receipt yet."
    : delivery === "failed" ? "This message is no longer waiting. Restore it to edit or send again."
    : delivery === "unknown" ? "Delivery could not be confirmed. Check the conversation before sending again."
    : undefined;
  return (
    <div className="message-bubble" data-noswipe={onStart || onCancel || onRestore || onDismiss ? "" : undefined}>
      {body}
      {(label || footer) && (
        <div className="message-delivery" data-delivery={delivery} aria-busy={pending}>
          <span className="message-delivery-status" role="status" title={detail}>{label}</span>
          <div className="message-delivery-actions" role="group" aria-label="Message actions">
            {onStart && <button type="button" disabled={pending}
              title={wrapUp ? "Stop the current reply and wrap up now" : "Stop the current reply and send this message next"}
              aria-label="Send this queued message now" onClick={onStart}>Send now</button>}
            {onCancel && (wrapUp ? <button type="button" disabled={pending}
              title="Take the wrap-up back. The chat is not completed."
              aria-label="Cancel completing this chat" onClick={onCancel}>Cancel</button>
              : <button type="button" disabled={pending}
              title="Return this message and its attachments to the composer"
              aria-label="Take this queued message back to edit" onClick={onCancel}>Edit</button>)}
            {onRestore && <button type="button" onClick={onRestore}>Restore to composer</button>}
            {onDismiss && <button type="button" onClick={onDismiss}>Dismiss</button>}
            {footer}
          </div>
        </div>
      )}
      {detail && !accepted && delivery !== "dispatched" && <p className="message-delivery-detail">{detail}</p>}
      {message.queueError && <p className="message-delivery-error" role="alert">{message.queueError}</p>}
    </div>
  );
}
