// An answer that stops because the backend did.
//
// Drawn at the END of the conversation and nowhere else, because that is the
// only place a cut turn can be: the restart ended every agent at once, and what
// it interrupted is whatever each chat was last saying.
//
// It is a strip above the prompt box rather than a message in the list. The
// list is the record — what was actually said — and nothing said this. This is
// the app admitting to something it did.
//
// One button, because there is only one thing to do. Everything else is already
// true: the words are on disk, the agent's own memory of the turn is on disk,
// and typing anything at all would resume the chat anyway. What the button adds
// is that the agent is told what happened and asked to finish, instead of the
// person having to guess the wording — see lib/carryOn.
export function CarryOn({ onCarryOn }: { onCarryOn: () => void }) {
  return (
    <div className="carry-on" role="status">
      <span className="carry-on-said">
        The backend stopped while this answer was being written. Nothing was lost — the agent still
        remembers the turn.
      </span>
      <button className="carry-on-btn" type="button" onClick={onCarryOn}>
        Carry on
      </button>
    </div>
  );
}
