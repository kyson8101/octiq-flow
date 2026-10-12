// Handovers in a chat: the card in the source chat that asks the person to
// confirm, at the end of the transcript while it waits on them, and the line
// each one leaves once it has settled: where the task went, in the chat that
// asked, and where it came from, at the start of the new chat. The decision is
// the person's alone: these buttons are the only thing that sends
// `handover_confirm`.
//
// A card that waits is a name card: who the work goes to, as a face and a
// name, then what will happen as a sentence or two, then the chat's settings
// in small print. The brief, the exact first message, paths and the HEAD
// commit sit behind the card's one disclosure (`components/CardFold`), drawn
// here as an envelope: a row named for what it holds and how much, never a
// piece of it, opening above the buttons.
//
// Confirmed, the face and the name go on to where the agent is named next
// (`lib/identityTravel`): the composer of the chat a route opened, or the
// line a handover leaves in this one.
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  askBackSummary, canDiscussInstead, chatIdOf, handoverHeadline, handoverWhere, homeShort, isRoute, latestOutcome, noticeLine,
  outcomeText, placeLine, routeFact, routeHeadline, settingsLine, waitsOnPerson,
  type Handover, type HandoverAction, type HandoverAsk, type handoverLayout,
} from "../lib/handover";
import { useRosterAgent } from "../lib/agentRoster";
import { briefRuns } from "../lib/briefRuns";
import { chars, count, isShort, lineCount, sizeLabel, tooLong, tooLongNote, WHOLE_MAX } from "../lib/cardFold";
import { forgetIdentity, landIdentity, leaveIdentity, lineLanding, refreshIdentity, rememberIdentity } from "../lib/identityTravel";
import { AgentAvatar } from "./AgentAvatar";
import { Arrive } from "./Arrive";
import { FoldBody, FoldLine, useFold, WholeText } from "./CardFold";
import "./HandoverCards.css";

type Open = (chatKey: string, projectId: string | null) => void;
type Decide = (id: string, action: HandoverAction) => Promise<unknown>;

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

/** What a folded handover says is behind its disclosure: the brief by its
 *  size, and how many things the agent says do and do not carry over. Counts
 *  only; the words are the agent's and stay folded. */
export function briefLabels(handover: Handover): string[] {
  const { brief } = handover;
  const lines = [brief.objective, brief.doneSoFar, brief.remaining, brief.decisions, brief.openQuestions]
    .reduce((sum, text) => sum + lineCount(text ?? ""), 0);
  return [
    lines > 0 ? `Brief · ${count(lines, "line")}` : "",
    brief.authorized?.length ? `${brief.authorized.length} said to carry over` : "",
    brief.notAuthorized?.length ? `${brief.notAuthorized.length} not authorized` : "",
    "Checkout",
  ].filter(Boolean);
}

/** Why a handover's brief cannot be handed over from its card, or "". Opened,
 *  a brief is every character of every part of it, so its parts are counted
 *  together: past what the page draws whole (`cardFold.WHOLE_MAX`) it is not
 *  opened in part, and what cannot be shown whole cannot be agreed to here.
 *  The host stops each part at 8,000 characters; this is the page's own
 *  bound, kept whatever a host sends. */
export function briefOver(handover: Handover): string {
  const { brief } = handover;
  const parts = [
    brief.objective, brief.doneSoFar, brief.remaining, brief.decisions, brief.openQuestions,
    ...(brief.authorized ?? []), ...(brief.notAuthorized ?? []),
  ].filter((part): part is string => !!part);
  // Never more characters than units, so this is every real brief, at no cost.
  if (parts.reduce((sum, part) => sum + part.length, 0) <= WHOLE_MAX) return "";
  const size = parts.reduce((sum, part) => sum + chars(part), 0);
  return size > WHOLE_MAX
    ? tooLongNote("brief", size, "be handed over from here", "Keep it here and ask for a shorter one.")
    : "";
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

/** Branch, HEAD-state and uncommitted changes, as git said when the card was
 *  made: the facts under a settled line. */
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

/** A project by its name, with the folder behind it one hover, focus or tap
 *  away. The folder is not on the card: it is here, and whole inside the
 *  opened brief for a screen with no pointer to hover with. */
function Place({ name, path }: { name: string; path?: string }) {
  const id = useId();
  if (!path) return <span className="handover-place">{name}</span>;
  const leave = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape") event.currentTarget.blur();
  };
  return (
    <span className="handover-place has-tip" tabIndex={0} aria-describedby={id} onKeyDown={leave}>
      {name}
      <span className="handover-tip" role="tooltip" id={id}>{homeShort(path)}</span>
    </span>
  );
}

/** Who the work goes to: the face, the name, what will happen as a sentence
 *  or two (`children`), and the chat's settings in small print. */
function Identity({ handover, working, children }: { handover: Handover; working: boolean; children: ReactNode }) {
  const face = useRosterAgent(handover.to.agentId);
  return (
    <header className="handover-id">
      <span className={`handover-face${working ? " is-working" : ""}`}>
        <AgentAvatar
          name={face?.name ?? handover.to.name}
          avatar={face?.avatar}
          id={handover.to.agentId ?? handover.to.name}
          size={44}
          decorative
        />
      </span>
      <div className="handover-who">
        <h3 className="handover-name"><span data-travel="name">{handover.to.name}</span></h3>
        {children}
        <p className="handover-settings"><span className="handover-sr">Chat settings: </span>{settingsLine(handover.settings)}</p>
      </div>
    </header>
  );
}

/** The answers of a card, and what a confirmed one hands on. `over` is why
 *  the card cannot send what it asks about ("" when it can): the answers
 *  that would send it are then off, not disabled and not gone, and keep
 *  their place with the reason read out. */
function useAnswers(handover: Handover, onDecide: Decide, over: string) {
  const card = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<HandoverAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const overId = useId();
  const { id } = handover;
  // A confirmed card's face and name go on from where the card was last
  // seen: as it is drawn, and as it leaves.
  useLayoutEffect(() => refreshIdentity(id, card.current));
  useLayoutEffect(() => {
    const element = card.current;
    return () => leaveIdentity(id, element);
  }, [id]);
  // A start that failed goes nowhere: the card stays, and asks again.
  const stuck = !!(error ?? handover.error);
  useEffect(() => {
    if (stuck) forgetIdentity(id);
  }, [stuck, id]);
  const decide = useCallback(async (action: HandoverAction) => {
    if (action === "confirm" || action === "discuss") rememberIdentity(id, card.current);
    setBusy(action);
    setError(null);
    try {
      await onDecide(id, action);
    } catch (reason) {
      setError(String((reason as Error)?.message ?? reason));
    } finally {
      setBusy(null);
    }
  }, [id, onDecide]);
  const send = (action: HandoverAction) => ({
    "aria-disabled": over ? true : undefined,
    "aria-describedby": over ? overId : undefined,
    title: over || undefined,
    onClick: () => { if (!over) void decide(action); },
  });
  return { card, busy, error, decide, send, overId };
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4 2.5 20h19z" />
      <path d="M12 10v4.5M12 17.4v.1" />
    </svg>
  );
}

/** The card that waits on the person: undecided, or confirmed and its new
 *  chat not running yet. Drawn at the end of the transcript until it settles,
 *  then replaced by a `HandoverLine` where the handover was asked for. */
function SourceCard({ handover, onDecide, startOpen = false }: {
  handover: Handover;
  onDecide: Decide;
  /** Draw it opened: for the tests, which cannot press the control. */
  startOpen?: boolean;
}) {
  const fold = useFold(handover.id, { startOpen });
  const pending = handover.status === "pending";
  // Confirmed, and its chat not started yet: it can only go forward.
  const starting = handover.status === "starting";
  const over = useMemo(() => briefOver(handover), [handover]);
  const { card, busy, error, decide, send, overId } = useAnswers(handover, onDecide, over);
  const failed = error ?? (pending || starting ? handover.error : undefined);
  // Undecided, or a start that failed: the badge in the chat list points here.
  const waiting = waitsOnPerson(handover);
  const where = handover.workspace.preparedCwd ?? handover.workspace.path;
  return (
    <section
      ref={card}
      className={`handover-card is-${handover.status}${waiting ? " is-waiting" : ""}`}
      data-handover={handover.id}
      data-status={handover.status}
      aria-label={handoverHeadline(handover, "source")}
      {...(waiting ? { "data-pending": "", "data-pending-keys": `handover:${handover.id}`, tabIndex: -1 } : {})}
    >
      <Identity handover={handover} working={starting && !failed}>
        <p className="handover-fact">Takes over this task · <Place name={handover.destination.projectName} path={where} /></p>
        <p className="handover-fact">
          {handoverWhere(handover).map((run, index) => run.mono ? <code key={index}>{run.text}</code> : run.text)}
        </p>
      </Identity>
      {over
        ? <p className="handover-over" id={overId}>{over}</p>
        : <>
          <FoldLine fold={fold} labels={briefLabels(handover)} what="the brief" />
          <FoldBody fold={fold}>
            <BriefBody handover={handover} />
          </FoldBody>
        </>}
      {failed && <p className="handover-error" role="alert">{failed}</p>}
      {pending && (
        <footer className="handover-actions">
          <span className="handover-hint">Nothing starts until you choose</span>
          <button type="button" className="handover-quiet" disabled={!!busy} onClick={() => void decide("decline")}>
            {busy === "decline" ? "Keeping…" : "Keep it here"}
          </button>
          <button type="button" className="handover-go" disabled={!!busy} {...send("confirm")}>
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
            <button type="button" className="handover-go" disabled={!!busy} {...send("confirm")}>
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

/** A brief as prose: its ids, paths and branches in mono, the words round
 *  them as written. */
function BriefProse({ text }: { text: string }) {
  return (
    <p className="route-brief-text">
      {briefRuns(text).map((run, index) => run.mono ? <code key={index}>{run.text}</code> : run.text)}
    </p>
  );
}

/** The front desk's proposal: which agent, in which project, with the brief
 *  it will receive. Confirming is the only thing that opens the chat; the
 *  page then goes there. Read top to bottom it answers who (the face and the
 *  name), what kind of chat and where (one sentence), with which files, and
 *  what: the brief and the exact first message, file paths and all, are in
 *  the envelope, named by their size and opened whole. */
export function RouteCard({ handover, onDecide, startOpen = false }: {
  handover: Handover;
  onDecide: Decide;
  /** Draw it opened: for the tests, which cannot press the control. */
  startOpen?: boolean;
}) {
  const fold = useFold(handover.id, { startOpen });
  const pending = handover.status === "pending";
  const starting = handover.status === "starting";
  // Confirmed, and still drawn: this page confirmed it and is on its way to
  // the chat (`lib/handover.handoverTail`). Nothing is left to answer.
  const going = handover.status === "confirmed";
  const route = handover.route;
  const files = route?.attachments ?? [];
  const unreadable = route?.unreadable ?? [];
  const discussInstead = canDiscussInstead(handover);
  const fact = routeFact(handover);
  // A head's conversation spans every project, so it has no one folder.
  const repository = route?.crossProject ? "" : handover.destination.repository;
  // A brief of one short line is a fact and stays on the card; a longer one
  // is what the person agrees to send, named by its size and opened whole.
  const brief = handover.brief.objective;
  const longBrief = !isShort(brief);
  const briefHead = <h4>Brief{handover.from.name && <span className="route-brief-from"> · from {handover.from.name}</span>}</h4>;
  // What opens the chat is the exact first message. One the page cannot draw
  // whole is not drawn in part, and the chat cannot be opened from this card:
  // what cannot be shown whole cannot be agreed to here.
  const message = route?.message ?? "";
  const over = useMemo(() => {
    for (const [what, text] of [["first message", message], ["brief", brief]] as const) {
      if (tooLong(text)) return tooLongNote(what, chars(text), "be sent from here", "Cancel it and ask for a shorter one.");
    }
    return "";
  }, [message, brief]);
  const { card, busy, error, decide, send, overId } = useAnswers(handover, onDecide, over);
  // A confirmed route's start did not fail, whatever an earlier try said.
  const failed = going ? undefined : error ?? handover.error;
  const waiting = waitsOnPerson(handover);
  return (
    <section
      ref={card}
      className={`handover-card route-card is-${handover.status}${waiting ? " is-waiting" : ""}`}
      data-handover={handover.id}
      data-status={handover.status}
      data-kind="route"
      aria-label={routeHeadline(handover)}
    >
      <Identity handover={handover} working={(starting || going) && !failed}>
        <p className="handover-fact">
          {fact.lead} · <Place name={fact.project} path={repository} />
          {fact.notes.map((note) => <Fragment key={note}> · {note}</Fragment>)}
        </p>
      </Identity>
      {files.length > 0 && (
        <p className="handover-files">
          With {count(files.length, "file")}: {files.map((file, index) => (
            <Fragment key={file.path}>{index > 0 && ", "}<code>{file.name}</code></Fragment>
          ))}
        </p>
      )}
      {unreadable.length > 0 && (
        <ul className="handover-unpassed" role="alert" aria-label="Not passed on">
          {unreadable.map((file) => (
            <li key={file.path}><WarnIcon /><span>Not passed on: {leafName(file.path)} ({file.problem})</span></li>
          ))}
        </ul>
      )}
      {!longBrief && brief.trim() && (
        <div className="route-brief">
          {briefHead}
          <BriefProse text={brief} />
        </div>
      )}
      {over ? <p className="handover-over" id={overId}>{over}</p> : <>
        <FoldLine
          fold={fold}
          labels={[
            longBrief && `Brief · ${sizeLabel(brief)}`,
            message && `Exact first message · ${sizeLabel(message)}`,
          ]}
          what="the brief"
        />
        <FoldBody fold={fold}>
          {longBrief && (
            <div className="route-brief">
              {briefHead}
              <BriefProse text={brief} />
            </div>
          )}
          {message && (
            <div className="route-message">
              <h4>Exact first message</h4>
              <WholeText text={message} className="route-message-text" />
            </div>
          )}
          {repository && (
            <div className="handover-section route-opens">
              <h4>Opens in</h4>
              <p className="handover-mono">{homeShort(repository)}</p>
            </div>
          )}
        </FoldBody>
      </>}
      {failed && <p className="handover-error" role="alert">{failed}</p>}
      {pending && (
        <footer className="handover-actions">
          <span className="handover-hint">Nothing opens until you choose</span>
          <button type="button" className="handover-quiet" disabled={!!busy} onClick={() => void decide("decline")}>
            {busy === "decline" ? "Cancelling…" : "Cancel"}
          </button>
          <button type="button" className="handover-go" disabled={!!busy} {...send("confirm")}>
            {busy === "confirm" ? "Opening…" : route?.discuss ? `Discuss with ${handover.to.name}` : `Open chat with ${handover.to.name}`}
          </button>
        </footer>
      )}
      {starting && (
        <footer className="handover-actions">
          <span className="handover-hint">
            {!handover.error
              ? "Opening the chat."
              : discussInstead
                ? "No chat was opened. Try again, open it read-only to discuss, or give up."
                : handover.abandonable
                  ? "No chat was opened. Try again, or give up."
                  : "Its chat may already have started, so it can only be tried again."}
          </span>
          {handover.error && handover.abandonable && (
            <button type="button" className="handover-quiet" disabled={!!busy} onClick={() => void decide("abandon")}>
              {busy === "abandon" ? "Giving up…" : "Give up"}
            </button>
          )}
          {discussInstead && (
            <button type="button" className="handover-quiet" disabled={!!busy} {...send("discuss")}>
              {busy === "discuss" ? "Opening…" : "Discuss only (read-only)"}
            </button>
          )}
          {handover.error && (
            <button type="button" className="handover-go" disabled={!!busy} {...send("confirm")}>
              {busy === "confirm" ? "Opening…" : "Try again"}
            </button>
          )}
        </footer>
      )}
      {going && (
        <footer className="handover-actions">
          <span className="handover-hint">Opening the chat.</span>
        </footer>
      )}
    </section>
  );
}

/** The handovers at the end of a chat: the ones the person still has to act
 *  on (`handoverPlaces(…).tail`), and, on the page that confirmed it, a
 *  route whose chat is being gone to (`handoverTail`). */
export function HandoverCards({ outgoing, onDecide, late, startOpen }: {
  outgoing: readonly Handover[];
  onDecide: (id: string, action: HandoverAction) => Promise<unknown>;
  /** The `handover:<id>` keys that turned up after the chat was drawn; those
   *  cards come in (`components/Arrive`), the rest are drawn in place. */
  late?: ReadonlySet<string>;
  /** Draw the cards opened: for the tests, which cannot press the control. */
  startOpen?: boolean;
}) {
  if (!outgoing.length) return null;
  return (
    <div className="handover-cards">
      {outgoing.map((handover) => (
        <Arrive key={handover.id} late={!!late?.has(`handover:${handover.id}`)}>
          {isRoute(handover)
            ? <RouteCard handover={handover} onDecide={onDecide} startOpen={startOpen} />
            : <SourceCard handover={handover} onDecide={onDecide} startOpen={startOpen} />}
        </Arrive>
      ))}
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
  // Handed over, in the chat that asked: the line says who has it now by
  // face as well as by name, and the card that was confirmed here shrinks
  // into it. Every other line keeps its mark.
  const handed = !incoming && handover.status === "confirmed";
  const face = useRosterAgent(handed ? handover.to.agentId : undefined);
  const line = useRef<HTMLDivElement>(null);
  const { id } = handover;
  useLayoutEffect(() => {
    if (handed) landIdentity(id, () => lineLanding(line.current));
  }, [handed, id]);
  return (
    <div ref={line} className={`handover-line is-${status}`} data-handover={handover.id} data-status={status}>
      <div className="handover-line-row">
        <span className="handover-line-what">
          {handed
            ? <AgentAvatar
              name={face?.name ?? handover.to.name}
              avatar={face?.avatar}
              id={handover.to.agentId ?? handover.to.name}
              size={16}
              decorative
              className="handover-line-face"
            />
            : <span className="handover-mark" aria-hidden="true" />}
          <span className="handover-line-text">
            {handed
              ? <>Handed over to <bdi data-travel="name">{handover.to.name}</bdi></>
              : handoverHeadline(handover, side)}
          </span>
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
