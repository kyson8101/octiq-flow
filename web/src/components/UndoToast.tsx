// Taking a delete back.
//
// Deleting a chat used to ask first, in a dialog in the middle of the screen.
// That is a long way for the pointer to travel from the little × in the
// sidebar that opened it, and a question answered "yes" every time stops being
// a question — it is just a second click. So the chat goes at once and the way
// out lives here instead: the row disappears, this says which chat it was, and
// for a few seconds Undo puts it back exactly where it stood.
//
// It sits bottom LEFT, under the sidebar the × was clicked in, so the pointer
// barely moves to reach it. Nothing behind it is blocked: the agents keep
// streaming, and the delete only reaches the server once this bar is gone.
//
// The draining line is CSS, not a ticking timer — the timer that actually
// commits the delete lives with the chat list, and two clocks counting the same
// three seconds would sooner or later disagree on screen.

export function UndoToast({
  title,
  ms,
  onUndo,
}: {
  /** The chat that went, for the sentence. Empty for one never named. */
  title: string;
  /** How long Undo stays on offer, in milliseconds. Drives the line only. */
  ms: number;
  onUndo: () => void;
}) {
  return (
    <div className="undo" role="status" aria-live="polite">
      <span className="undo-text">
        {"Deleted "}
        <span className="undo-name">{title.trim() || "the chat"}</span>
      </span>
      <button className="undo-btn" type="button" onClick={onUndo}>
        Undo
      </button>
      <span className="undo-drain" style={{ animationDuration: `${ms}ms` }} />
    </div>
  );
}
