// The rows above the composer that report and ask nothing: the chat's folder
// is gone, the chat is completing, background notices, the run's progress.
//
// They are one group, not four boxes: one line each, the same left edge and
// icon column (which is the eyebrow's own, so the faces under them line up),
// no fill and no border of their own, a hairline between rows at most. What
// a row has to say about its state is the colour of its icon or dot and
// nothing else. A row's dismiss shows under the pointer and the keyboard, and
// always where there is no pointer.
//
// A card that asks (permission, question, access, safety) is not a row of
// this group and keeps its own look.
//
// The group grows upward: it sits on the composer, so a row arriving never
// moves the box under it.
import type { ReactNode } from "react";
import "./ChatStatus.css";

export function ChatStatus({ children }: { children: ReactNode }) {
  return <div className="chat-status">{children}</div>;
}

/** The mark of a row that opens. It turns; the row's button owns the state. */
export function StatusChevron() {
  return (
    <span className="status-row-chevron" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="m4.5 6 3.5 3.5L11.5 6" />
      </svg>
    </span>
  );
}

/** A row's own way out. Quiet until the row is under the pointer or holds
 *  the focus; a touch screen has neither, so there it is always drawn. */
export function StatusDismiss({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="status-row-dismiss" aria-label={label} title={label} onClick={onClick}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" />
      </svg>
    </button>
  );
}
