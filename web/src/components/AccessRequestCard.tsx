// The agent asks for more access; the person decides here.
//
// The card says three things: the level the chat runs at, the level asked
// for, and why. Upgrade is the change — the page sends the same
// `chat_set_access` the access picker does — and only once that has worked
// does the card tell the host, which reads the chat's level back for the
// agent. Nothing the agent sends moves a level.
import { useState } from "react";
import { accessLabel } from "../lib/agentProviders";
import {
  accessRequestNote,
  accessRequestTitle,
  raiseRestarts,
  type AccessRequest,
} from "../lib/accessRequest";

export type AccessAnswer = "raise" | "decline";

/** What the page does with an answer. A raise that fails rejects with the
 *  reason, which the card shows when no agent is waiting to be told. */
export type AnswerAccess = (request: AccessRequest, answer: AccessAnswer) => Promise<void>;

export function AccessRequestCard({ request, onAnswer }: { request: AccessRequest; onAnswer: AnswerAccess }) {
  const [sending, setSending] = useState<AccessAnswer | null>(null);
  const [error, setError] = useState("");
  const label = (level: AccessRequest["current"]) => accessLabel(request.agent, level);

  const answer = async (choice: AccessAnswer) => {
    setSending(choice);
    setError("");
    try {
      await onAnswer(request, choice);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
      setSending(null);
    }
  };

  return (
    <div className="ask-card access-card" role="alertdialog" aria-label="Access requested">
      <div className="ask-card-head">
        <span className="ask-card-dot" aria-hidden="true" />
        <span className="ask-card-title">{accessRequestTitle(request)}</span>
      </div>

      <dl className="access-card-levels">
        <div>
          <dt className="ask-card-label">Now</dt>
          <dd>{label(request.current)}</dd>
        </div>
        <span className="access-card-arrow" aria-hidden="true">→</span>
        <div>
          <dt className="ask-card-label">Asked for</dt>
          <dd>{label(request.requested)}</dd>
        </div>
      </dl>

      {request.reason && (
        <div className="ask-card-detail">
          <div className="ask-card-label">Why</div>
          <p className="access-card-reason">{request.reason}</p>
        </div>
      )}

      {error && <p className="access-card-error" role="alert">{error}</p>}

      <div className="ask-card-buttons">
        <button className="ask-btn" type="button" disabled={!!sending} onClick={() => void answer("decline")}>
          {sending === "decline" ? "Declining…" : "Not now"}
        </button>
        <button className="ask-btn is-primary" type="button" disabled={!!sending} onClick={() => void answer("raise")}>
          {sending === "raise" ? "Raising…" : `Raise to ${label(request.requested)}`}
        </button>
      </div>

      <p className="ask-card-note">
        {accessRequestNote(request)}
        {raiseRestarts(request) && " This level needs a fresh agent: raising it ends the turn now, and your next message continues at it."}
      </p>
    </div>
  );
}
