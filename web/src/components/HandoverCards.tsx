// Handovers in a chat: the card in the source chat that asks the person to
// confirm, at the end of the transcript while it waits on them, and the line
// each one leaves once it has settled: where the task went, in the chat that
// asked, and where it came from, at the start of the new chat. The decision is
// the person's alone: these buttons are the only thing that sends
// `handover_confirm`.
//
// Labels and counts up front; the brief, paths and the HEAD commit sit behind
// a disclosure, like every other piece of agent prose.
import { useId, useState } from "react";
import {
  chatIdOf, handoverHeadline, noticeLine, placeLine, settingsLine,
  type Handover, type HandoverAction,
} from "../lib/handover";
import "./HandoverCards.css";

type Open = (chatKey: string, projectId: string | null) => void;

function Section({ title, text }: { title: string; text?: string }) {
  if (!text?.trim()) return null;
  return (
    <div className="handover-section">
      <h4>{title}</h4>
      <p>{text}</p>
    </div>
  );
}

function List({ title, items, quoted }: { title: string; items?: string[]; quoted?: boolean }) {
  if (!items?.length) return null;
  return (
    <div className="handover-section">
      <h4>{title}</h4>
      <ul>{items.map((item, i) => <li key={i}>{quoted ? `“${item}”` : item}</li>)}</ul>
    </div>
  );
}

/** The brief and the checkout details, folded. */
function BriefDetails({ handover }: { handover: Handover }) {
  return (
    <details className="handover-brief">
      <summary>
        <span>Brief</span>
        <span className="handover-chevron" aria-hidden="true" />
      </summary>
      <BriefBody handover={handover} />
    </details>
  );
}

/** What the agent wrote for the recipient, and where the work is. */
function BriefBody({ handover }: { handover: Handover }) {
  const { brief, workspace } = handover;
  const where = workspace.preparedCwd ?? workspace.path;
  return (
    <div className="handover-brief-body">
      <Section title="Objective" text={brief.objective} />
      <Section title="Done so far" text={brief.doneSoFar} />
      <Section title="Remaining" text={brief.remaining} />
      <Section title="Decisions and gotchas" text={brief.decisions} />
      <Section title="Open questions" text={brief.openQuestions} />
      <List
        title={`${handover.from.name} says these carry over`}
        items={brief.authorized}
        quoted
      />
      {!!brief.authorized?.length && (
        <p className="handover-caveat">The agent's words, not a permission: approvals stay with each chat.</p>
      )}
      <List title="Not authorized" items={brief.notAuthorized} />
      <div className="handover-section">
        <h4>Checkout</h4>
        <p className="handover-mono">{where}</p>
        {workspace.head && <p className="handover-mono">HEAD {workspace.head}</p>}
        {handover.destination.repository !== where && (
          <p className="handover-mono">Repository {handover.destination.repository}</p>
        )}
      </div>
    </div>
  );
}

/** Branch, HEAD-state and uncommitted changes, as git said when the card was made. */
function Facts({ handover }: { handover: Handover }) {
  const ws = handover.workspace;
  return (
    <dl className="handover-facts">
      <div><dt>To</dt><dd>{handover.to.name} <span className="handover-dim">· {settingsLine(handover.settings)}</span></dd></div>
      <div><dt>Where</dt><dd>{placeLine(handover)}</dd></div>
      {ws.mode === "continue" && ws.uncommitted !== undefined && (
        <div><dt>Changes</dt><dd>{ws.uncommitted ? "Uncommitted changes travel with it" : "Nothing uncommitted"}</dd></div>
      )}
    </dl>
  );
}

/** The card that waits on the person: undecided, or confirmed and its new
 *  chat not running yet. Drawn at the end of the transcript until it settles,
 *  then replaced by a `HandoverLine` where the handover was asked for. */
function SourceCard({ handover, onDecide }: {
  handover: Handover;
  onDecide: (id: string, action: HandoverAction) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<HandoverAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = handover.status === "pending";
  // Confirmed, and its chat not started yet: it can only go forward.
  const starting = handover.status === "starting";
  const decide = async (action: HandoverAction) => {
    setBusy(action);
    setError(null);
    try {
      await onDecide(handover.id, action);
    } catch (reason) {
      setError(String((reason as Error)?.message ?? reason));
    } finally {
      setBusy(null);
    }
  };
  const failed = error ?? (pending || starting ? handover.error : undefined);
  return (
    <section
      className={`handover-card is-${handover.status}`}
      data-handover={handover.id}
      data-status={handover.status}
      {...(pending ? { "data-pending": "", "data-pending-keys": `handover:${handover.id}`, tabIndex: -1 } : {})}
    >
      <header className="handover-head">
        <span className="handover-mark" aria-hidden="true" />
        <h3>{handoverHeadline(handover, "source")}</h3>
      </header>
      <Facts handover={handover} />
      <BriefDetails handover={handover} />
      {failed && <p className="handover-error" role="alert">{failed}</p>}
      {pending && (
        <footer className="handover-actions">
          <span className="handover-hint">Nothing starts until you choose.</span>
          <button type="button" className="handover-quiet" disabled={!!busy} onClick={() => void decide("decline")}>
            {busy === "decline" ? "Keeping…" : "Keep it here"}
          </button>
          <button type="button" className="handover-go" disabled={!!busy} onClick={() => void decide("confirm")}>
            {busy === "confirm" ? "Handing over…" : `Hand over to ${handover.to.name}`}
          </button>
        </footer>
      )}
      {starting && (
        <footer className="handover-actions">
          <span className="handover-hint">
            {!handover.error
              ? "Starting the new chat."
              : handover.abandonable
                ? "No chat was started. Try again, or give up and keep the task here."
                : "Its chat may already have started, so it can only be tried again."}
          </span>
          {handover.error && handover.abandonable && (
            <button type="button" className="handover-quiet" disabled={!!busy} onClick={() => void decide("abandon")}>
              {busy === "abandon" ? "Giving up…" : "Give up"}
            </button>
          )}
          {handover.error && (
            <button type="button" className="handover-go" disabled={!!busy} onClick={() => void decide("confirm")}>
              {busy === "confirm" ? "Starting…" : "Try again"}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}

/** The handovers at the end of a chat: only the ones the person still has to
 *  act on (`handoverPlaces(…).tail`). */
export function HandoverCards({ outgoing, onDecide }: {
  outgoing: readonly Handover[];
  onDecide: (id: string, action: HandoverAction) => Promise<unknown>;
}) {
  if (!outgoing.length) return null;
  return (
    <div className="handover-cards">
      {outgoing.map((handover) => (
        <SourceCard key={handover.id} handover={handover} onDecide={onDecide} />
      ))}
    </div>
  );
}

/** A settled handover, as one line of the transcript: where the task went, or
 *  where it came from. The facts and the brief open under it, and the other
 *  chat is one click away. Declined and given-up ones are the headline only. */
export function HandoverLine({ handover, side, onOpen, projectOf }: {
  handover: Handover;
  /** `source`: drawn in the chat that asked. `target`: in the chat it started. */
  side: "source" | "target";
  onOpen: Open;
  projectOf?: (chatKey: string) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const incoming = side === "target";
  const quiet = !incoming && handover.status !== "confirmed";
  const other = incoming ? handover.sourceChatKey : handover.targetChatKey;
  const notice = incoming ? null : noticeLine(handover);
  const status = incoming ? "incoming" : handover.status;
  return (
    <div className={`handover-line is-${status}`} data-handover={handover.id} data-status={status}>
      <div className="handover-line-row">
        <span className="handover-line-what">
          <span className="handover-mark" aria-hidden="true" />
          <span className="handover-line-text">{handoverHeadline(handover, side)}</span>
        </span>
        {/* On a narrow screen these drop under the headline rather than
            cutting it short: the headline is what the line is for. */}
        {!quiet && (
          <span className="handover-line-tools">
            <button
              type="button"
              className="handover-line-btn"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setOpen((was) => !was)}
            >
              Brief
              <span className="handover-chevron" aria-hidden="true" />
            </button>
            {other && (
              <button
                type="button"
                className="handover-line-btn"
                data-open-chat={chatIdOf(other)}
                onClick={() => onOpen(other, incoming ? projectOf?.(other) ?? null : handover.destination.projectId)}
              >
                {incoming ? "Open the original chat" : `Open ${handover.to.name}'s chat`}
              </button>
            )}
          </span>
        )}
      </div>
      {notice && <p className="handover-note">{notice}</p>}
      {!quiet && (
        <div id={bodyId} className="handover-line-body" hidden={!open}>
          {incoming ? (
            <dl className="handover-facts">
              <div><dt>From</dt><dd>{handover.sourceTitle || "Untitled chat"}</dd></div>
              <div><dt>Where</dt><dd>{placeLine(handover)}</dd></div>
            </dl>
          ) : <Facts handover={handover} />}
          <BriefBody handover={handover} />
        </div>
      )}
    </div>
  );
}

/** Several settled handovers in one place: the head of a transcript, or the
 *  turn that asked for them. */
export function HandoverLines({ incoming, outgoing, onOpen, projectOf }: {
  incoming?: Handover | null;
  outgoing?: readonly Handover[];
  onOpen: Open;
  projectOf?: (chatKey: string) => string | null;
}) {
  if (!incoming && !outgoing?.length) return null;
  return (
    <div className="handover-lines">
      {incoming && <HandoverLine handover={incoming} side="target" onOpen={onOpen} projectOf={projectOf} />}
      {outgoing?.map((handover) => (
        <HandoverLine key={handover.id} handover={handover} side="source" onOpen={onOpen} />
      ))}
    </div>
  );
}
