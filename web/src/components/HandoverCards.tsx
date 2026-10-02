// Handovers in a chat: the card in the source chat that asks the person to
// confirm, at the end of the transcript while it waits on them, and the line
// each one leaves once it has settled: where the task went, in the chat that
// asked, and where it came from, at the start of the new chat. The decision is
// the person's alone: these buttons are the only thing that sends
// `handover_confirm`.
//
// Labels and counts up front; the brief, paths and the HEAD commit sit behind
// a disclosure, like every other piece of agent prose.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  askBackSummary, chatIdOf, handoverHeadline, isRoute, latestOutcome, noticeLine, outcomeText, placeLine,
  routeHeadline, routePlaceLine, settingsLine, waitsOnPerson,
  type Handover, type HandoverAction, type HandoverAsk, type handoverLayout,
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
  // Undecided, or a start that failed: the badge in the chat list points here.
  const waiting = waitsOnPerson(handover);
  return (
    <section
      className={`handover-card is-${handover.status}`}
      data-handover={handover.id}
      data-status={handover.status}
      {...(waiting ? { "data-pending": "", "data-pending-keys": `handover:${handover.id}`, tabIndex: -1 } : {})}
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

/** The last folder or file of a path, for a label. */
function leafName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** The front desk's proposal: which agent, in which project, with the brief
 *  it will receive. Confirming is the only thing that opens the chat; the
 *  page then goes there. The brief is shown whole, since it is what the
 *  person is agreeing to send; the exact first message, file paths and all,
 *  is one click further. */
export function RouteCard({ handover, onDecide }: {
  handover: Handover;
  onDecide: (id: string, action: HandoverAction) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<HandoverAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = handover.status === "pending";
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
  const route = handover.route;
  const files = route?.attachments ?? [];
  const unreadable = route?.unreadable ?? [];
  const failed = error ?? handover.error;
  return (
    <section
      className={`handover-card route-card is-${handover.status}`}
      data-handover={handover.id}
      data-status={handover.status}
      data-kind="route"
    >
      <header className="handover-head">
        <span className="handover-mark" aria-hidden="true" />
        <h3>{routeHeadline(handover)}</h3>
      </header>
      <dl className="handover-facts">
        <div><dt>Agent</dt><dd>{handover.to.name} <span className="handover-dim">· {settingsLine(handover.settings)}</span></dd></div>
        <div><dt>Project</dt><dd>{routePlaceLine(handover)}</dd></div>
        {files.length > 0 && (
          <div><dt>Files</dt><dd>{files.map((file) => file.name).join(", ")}</dd></div>
        )}
      </dl>
      <div className="route-brief">
        <h4>Brief</h4>
        <p className="route-brief-text">{handover.brief.objective}</p>
      </div>
      {unreadable.length > 0 && (
        <ul className="route-unreadable" role="alert" aria-label="Not passed on">
          {unreadable.map((file) => (
            <li key={file.path}>Not passed on: {leafName(file.path)} ({file.problem})</li>
          ))}
        </ul>
      )}
      {route?.message && (
        <details className="handover-brief route-message">
          <summary>
            <span>Exact first message</span>
            <span className="handover-chevron" aria-hidden="true" />
          </summary>
          <pre className="route-message-text">{route.message}</pre>
        </details>
      )}
      {failed && <p className="handover-error" role="alert">{failed}</p>}
      {pending && (
        <footer className="handover-actions">
          <span className="handover-hint">Nothing opens until you choose.</span>
          <button type="button" className="handover-quiet" disabled={!!busy} onClick={() => void decide("decline")}>
            {busy === "decline" ? "Cancelling…" : "Cancel"}
          </button>
          <button type="button" className="handover-go" disabled={!!busy} onClick={() => void decide("confirm")}>
            {busy === "confirm" ? "Opening…" : `Open chat with ${handover.to.name}`}
          </button>
        </footer>
      )}
      {starting && (
        <footer className="handover-actions">
          <span className="handover-hint">
            {!handover.error
              ? "Opening the chat."
              : handover.abandonable
                ? "No chat was opened. Try again, or give up."
                : "Its chat may already have started, so it can only be tried again."}
          </span>
          {handover.error && handover.abandonable && (
            <button type="button" className="handover-quiet" disabled={!!busy} onClick={() => void decide("abandon")}>
              {busy === "abandon" ? "Giving up…" : "Give up"}
            </button>
          )}
          {handover.error && (
            <button type="button" className="handover-go" disabled={!!busy} onClick={() => void decide("confirm")}>
              {busy === "confirm" ? "Opening…" : "Try again"}
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
      {outgoing.map((handover) => isRoute(handover)
        ? <RouteCard key={handover.id} handover={handover} onDecide={onDecide} />
        : <SourceCard key={handover.id} handover={handover} onDecide={onDecide} />)}
    </div>
  );
}

const ASK_STATUS: Record<HandoverAsk["status"], string> = {
  asking: "Waiting for an answer",
  answered: "Answered",
  failed: "No answer",
};

/** The questions the new chat asked back, under a count. Their words are
 *  agent prose, so they open only on request, like peer help. */
function AskBackLog({ handover }: { handover: Handover }) {
  const asks = handover.asks ?? [];
  if (!asks.length) return null;
  return (
    <details className="handover-asks" data-asks={asks.length}>
      <summary>
        <span>{askBackSummary(asks)}</span>
        <span className="handover-chevron" aria-hidden="true" />
      </summary>
      <ol aria-label={`Questions ${handover.to.name} asked ${handover.from.name}`}>
        {asks.map((ask) => (
          <li key={ask.id} data-ask={ask.id} data-status={ask.status}>
            <p className="handover-ask-who">
              <strong><bdi>{handover.to.name}</bdi></strong> asked <strong><bdi>{handover.from.name}</bdi></strong>
              <span> · {ASK_STATUS[ask.status]}</span>
            </p>
            <p className="handover-ask-question">{ask.question}</p>
            {ask.contextPaths?.length ? (
              <p className="handover-ask-paths">Pointed at {ask.contextPaths.map((path, index) => (
                <span key={path}>{index > 0 && ", "}<code>{path}</code></span>
              ))}</p>
            ) : null}
            {ask.status === "answered" && (
              <p className="handover-ask-answer">
                {ask.answer}{ask.truncated && <em> (answer cut at the length limit)</em>}
              </p>
            )}
            {ask.status === "failed" && <p className="handover-ask-error">{ask.error ?? "No answer came back."}</p>}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** What the new chat said came of the work: the latest report, on one line.
 *  A summary runs to a thousand characters, and a tooltip is no use on a
 *  phone, so a line that is cut short opens in place on a tap and shows the
 *  whole of it. Whether it is cut is measured, never guessed from the length. */
function OutcomeLine({ handover }: { handover: Handover }) {
  const outcome = latestOutcome(handover);
  const text = outcome ? outcomeText(handover, outcome) : "";
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useEffect(() => setOpen(false), [text]);
  // Only while shut: an open line is never cut, and would hide its own toggle.
  useLayoutEffect(() => {
    const line = ref.current;
    if (!line || open) return;
    const measure = () => setClipped(line.scrollWidth > line.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    return () => observer.disconnect();
  }, [text, open]);
  if (!outcome) return null;
  return (
    <div className={`handover-outcome is-${outcome.status}${open ? " is-open" : ""}`} data-outcome={outcome.status}>
      <span className="handover-outcome-mark" aria-hidden="true" />
      <span className="handover-outcome-text" id={id} ref={ref}>{text}</span>
      <button
        type="button"
        className="handover-outcome-toggle"
        hidden={!clipped && !open}
        aria-expanded={open}
        aria-controls={id}
        aria-label={open ? "Show less of the outcome" : "Show the whole outcome"}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="handover-chevron" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Earlier outcome reports, when the latest replaced some. */
function OutcomeHistory({ handover }: { handover: Handover }) {
  const outcomes = handover.outcomes ?? [];
  if (outcomes.length < 2) return null;
  return (
    <div className="handover-section">
      <h4>Outcome reports</h4>
      <ul>{outcomes.slice().reverse().map((outcome) => (
        <li key={outcome.requestId}>{outcomeText(handover, outcome)}</li>
      ))}</ul>
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
          <OutcomeHistory handover={handover} />
          <BriefBody handover={handover} />
        </div>
      )}
      {/* Under the Brief, so an open Brief stays with the line it opens from. */}
      {!quiet && <OutcomeLine handover={handover} />}
      {!quiet && <AskBackLog handover={handover} />}
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

/** The settled lines of a `handoverLayout`, as MessageList's `head` and
 *  `marks`. The tail is `HandoverCards` over `layout.tail`. */
export function handoverTranscript(
  layout: ReturnType<typeof handoverLayout>,
  onOpen: Open,
  projectOf?: (chatKey: string) => string | null,
): { head?: ReactNode; marks?: Map<string, ReactNode> } {
  const marks = new Map<string, ReactNode>();
  for (const [at, list] of layout.marks) {
    marks.set(at, <HandoverLines key={`handover-${at}`} outgoing={list} onOpen={onOpen} />);
  }
  const { incoming, outgoing } = layout.head;
  return {
    head: incoming || outgoing.length
      ? <HandoverLines incoming={incoming} outgoing={outgoing} onOpen={onOpen} projectOf={projectOf} />
      : undefined,
    marks: marks.size ? marks : undefined,
  };
}
