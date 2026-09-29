import { useId, useState } from "react";
import { chatIdOf, earlierState, memoryHeadline, type MemoryActivity } from "../lib/memoryActivity";
import { chatRouteHash } from "../lib/chatRoute";
import "./MemoryNote.css";

/** The host's line for an agent's memory write, drawn where it happened.
 *
 *  A row of its own rather than a tool card: the calls around it fold away,
 *  and this is the one thing in the turn that says the agent's memory changed.
 *  Everything on it comes from the vault's receipt, never from the agent's
 *  prose. Details open onto exactly what this write appended — not the note.
 *
 *  A worker's coordinator gets the same line without the words, and a link to
 *  the worker chat that holds them. */
export function MemoryNote({ activity }: { activity: MemoryActivity }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const { status, source } = activity;
  const when = activity.at ? new Date(activity.at) : undefined;
  const hasDetails = !source && !!(activity.text || activity.note || activity.receipt || activity.error);
  // A refused call is two facts: this call wrote nothing, and the earlier
  // change under its requestId stands as it is. Both show without opening.
  const earlier = earlierState(activity);

  return (
    <div className={`memory-note is-${status} ${open ? "is-open" : ""}`} data-memory-status={status}>
      <div className="memory-note-head">
        <span className="memory-note-icon" aria-hidden="true">
          {status === "saved" ? (
            <BrainIcon />
          ) : status === "uncertain" ? (
            <QuestionIcon />
          ) : status === "refused" ? (
            <BanIcon />
          ) : (
            <CrossIcon />
          )}
        </span>
        <span className="memory-note-title">
          {memoryHeadline(activity)}
          {source?.taskTitle && <span className="memory-note-task"> · {source.taskTitle}</span>}
        </span>
        {when && (
          <time className="memory-note-time" dateTime={when.toISOString()} title={when.toLocaleString()}>
            {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        )}
        {source ? (
          <a className="memory-note-action" href={chatRouteHash({ chat: chatIdOf(source.chatKey) })}>
            Open chat
          </a>
        ) : hasDetails ? (
          <button
            type="button"
            className="memory-note-action"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen(!open)}
          >
            {open ? "Hide" : "Details"}
            <Chevron open={open} />
          </button>
        ) : null}
      </div>
      {earlier && (
        <div className={`memory-note-earlier is-${activity.earlier?.status === "saved" ? "saved" : "unsure"}`}>
          <span className="memory-note-earlier-icon" aria-hidden="true">
            {activity.earlier?.status === "saved" ? <BrainIcon /> : <QuestionIcon />}
          </span>
          <span>{earlier}</span>
        </div>
      )}
      {hasDetails && (
        <div id={detailsId} className="memory-note-details" hidden={!open}>
          {activity.error && <p className="memory-note-error">{activity.error}</p>}
          {activity.text && (
            <>
              <div className="memory-note-label">{status === "saved" ? "Appended" : "Entry"}</div>
              <blockquote className="memory-note-text">{activity.text}</blockquote>
            </>
          )}
          <dl className="memory-note-facts">
            {activity.note && (
              <>
                <dt>Note</dt>
                <dd><code>{activity.note}</code></dd>
              </>
            )}
            {activity.date && (
              <>
                <dt>Dated</dt>
                <dd>{activity.date}</dd>
              </>
            )}
            {activity.receipt && (
              <>
                <dt>Receipt</dt>
                <dd>
                  <code title={activity.receipt.id}>{activity.receipt.id.slice(0, 12)}</code>
                  {activity.receipt.status && ` · ${activity.receipt.status.replace("_", " ")}`}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </div>
  );
}

/** Lucide's "brain" (ISC). */
function BrainIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
      <path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
      <path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
      <path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
      <path d="M19.938 10.5a4 4 0 0 1 .585.396" />
      <path d="M6 18a4 4 0 0 1-1.967-.516" />
      <path d="M19.967 17.484A4 4 0 0 1 18 18" />
    </svg>
  );
}

function QuestionIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.2" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** Lucide's "ban" (ISC): refused, as distinct from failed. */
function BanIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="m5.7 5.7 12.6 12.6" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="m15 9-6 6M9 9l6 6" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`memory-note-chevron ${open ? "is-open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
