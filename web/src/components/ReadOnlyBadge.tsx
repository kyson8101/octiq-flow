// A task (worker) chat takes no messages from the person: instructions go
// through its main chat, so the coordinating agent stays informed. This says
// so beside the chat's title, in a word, instead of a block under the
// transcript that took the composer's room.
import "./ReadOnlyBadge.css";

export function ReadOnlyBadge({ className = "" }: { className?: string }) {
  return (
    <span className={`read-only-badge ${className}`.trim()} role="note"
      aria-label="Read-only. Send instructions in the main chat."
      title="Read-only · send instructions in the main chat">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
      Read-only
    </span>
  );
}
