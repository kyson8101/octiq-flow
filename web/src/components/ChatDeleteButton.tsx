import { ActionIcon } from "./ActionIcon";
// The delete action shown in the chat's action bar. It uses the same two-second
// undo window as the sidebar row: the first press starts deleting, and the
// second press cancels while the ring is still draining.
export function ChatDeleteButton({
  deleting,
  disabled = false,
  deleteMs,
  onDelete,
}: {
  deleting: boolean;
  disabled?: boolean;
  deleteMs: number;
  onDelete: () => void;
}) {
  const label = deleting ? "Cancel delete" : "Delete this chat";

  return (
    <button
      className={`icon-btn topbar-delete ${deleting ? "is-going" : ""}`}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onDelete}
     data-icon-action>
      {deleting ? <DeleteCountdownIcon ms={deleteMs} /> : <ActionIcon name="delete" />}
    </button>
  );
}

/** A CSS-driven clock shared by both places that can start or undo a delete. */
export function DeleteCountdownIcon({ ms }: { ms: number }) {
  return (
    <svg className="chat-drain" width="17" height="17" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="chat-drain-track" cx="8" cy="8" r="6.6" />
      <circle
        className="chat-drain-arc"
        cx="8"
        cy="8"
        r="6.6"
        style={{ animationDuration: `${ms}ms` }}
      />
      <path className="chat-drain-x" d="M9.9 6.1 6.1 9.9M6.1 6.1l3.8 3.8" />
    </svg>
  );
}
