// The agent asking you something, in the conversation, where it asked.
//
// Print mode is never offered AskUserQuestion, so questions arrive through a
// tool of our own (scripts/mcp/octiq-ask.cjs). They used to be a card above
// the composer. They are drawn in the transcript now, at the `ask_user` call
// that asked them, with no card round them: each question a heading line,
// its options as radio rows (checkbox rows when it takes a set), and one
// button under the last. Every question of one call is one block with one
// button. A batch whose call the page does not hold is drawn at the end of
// the transcript (`lib/questionBlock.placeQuestions`).
//
// Three rules hold it up:
//
// - Nothing is folded. The question, the options and what each option means
//   are the whole of what is being chosen, and a disclosure among them would
//   slide a control under the pointer that pressed it. `Other…` reveals its
//   text box under itself, and only the button moves.
// - It arrives under the pointer and the keyboard, with the recommended
//   option already selected, so it must not be answered by the press or the
//   key that was already going on. It never takes the focus (the composer
//   keeps it), the button drops a key held down, and it drops a pointer press
//   that repeats the one made before the block was there (`lib/pressGuard`).
// - Answered, the questions become a quiet line and the answer is the
//   person's bubble under it. The bubble is drawn from what the host holds
//   (the question's record while it is listed, the call's result, the
//   host's `octiq_question_answered` line in the chat's record, the host's
//   own answer turn): it is the same after delivery, after a reload and in
//   a second tab. What this page remembers of an answer it just sent is
//   shown only until the host's word arrives, and never stands in for a
//   question that has no answer. It is not a message: it has no edit, no
//   retry, no take-back, and never goes to the composer.
// - A block is whole before it can be sent. The host says how many
//   questions a call carried and sends them one event each; until the last
//   has arrived the button is off and says it is still reading them.
import { createContext, useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { AskItem } from "../lib/askAnswer";
import { bridge } from "../lib/bridge";
import { questionActions } from "../lib/pendingActions";
import { dropHeld, lastPointerPress, strayAnswer } from "../lib/pressGuard";
import type { Question, QuestionAnswered } from "../lib/question";
import { choicesOf, togglePick } from "../lib/questionAnswer";
import {
  answeredItems, answeredNote, asks, batchParts, partNote, pickAnswer, saidLines, startPick, stillMissing, submitReason, waitingLabel,
  type AnsweredPlacement, type Batch, type Picked, type Placement, type Said,
} from "../lib/questionBlock";
import { hiddenNow, revealWaiting, subscribeSight, watchBlock } from "../lib/questionSight";
import {
  missingQuestionCommand, PartialQuestionSubmission, submitLegacyQuestionAnswers, submitQuestionAnswers,
  type QuestionReceipt,
} from "../lib/submitQuestionAnswers";
import { useLiveEntry } from "./Arrive";
import "./InlineQuestions.css";

/** What an older host is sent for a question dismissed without an answer; a
 *  host with the durable store has its own command for that. */
const DECLINED =
  "The user closed this question without answering. Do not assume an answer — " +
  "say what you need and stop, or continue in a way that does not depend on it.";

/* ---- What the transcript is handed ---------------------------------------- */

/** The open chat's pending questions and the way to drop answered ones.
 *  Provided by App for a chat the person can answer in; absent anywhere else
 *  (a worker's chat, the task chat beside a run, a subagent's view), where an
 *  `ask_user` call keeps its tool row. */
export type ChatQuestions = { questions: readonly Question[]; onDone: (ids: string[]) => void };
export const ChatQuestionsContext = createContext<ChatQuestions | null>(null);

/** Where each pending batch is drawn, worked out once by the transcript. */
export type AskPlaces = {
  placement: Placement;
  /** Answers that came back after their call ended, by the words asked. */
  late: ReadonlyMap<string, AskItem[]>;
  onDone: (ids: string[]) => void;
};
export const AskPlacesContext = createContext<AskPlaces | null>(null);

/** Where each delivered question of the transcript is drawn
 *  (`lib/questionBlock.placeAnswered`). Provided for every transcript, the
 *  ones nobody can answer in too: a record is read, not answered. */
export const AnsweredPlacesContext = createContext<AnsweredPlacement | null>(null);

/* ---- The block that asks -------------------------------------------------- */

/** What this page just sent, until the host's own word for it arrives:
 *  which questions, what was said, and what the host answered. */
type Sent = { ids: string[]; items: AskItem[]; receipt: QuestionReceipt };

/** One more send of the same block, beside what it sent before: a call
 *  answered in two parts is still one call. */
function alsoSent(before: Sent | null, next: Sent): Sent {
  if (!before) return next;
  const kept = before.ids.map((id, index) => ({ id, item: before.items[index] })).filter((each) => !next.ids.includes(each.id));
  return { ids: [...kept.map((each) => each.id), ...next.ids], items: [...kept.map((each) => each.item), ...next.items], receipt: next.receipt };
}

function QuestionForm({ batch, questions, onDone, onSent }: {
  batch: Batch;
  /** The questions of the batch still to answer here. */
  questions: readonly Question[];
  onDone: (ids: string[]) => void;
  onSent: (sent: Sent) => void;
}) {
  const [picks, setPicks] = useState<Record<string, Picked>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  /** The pointer press made before this block was on screen. One that is
   *  repeated onto the button was aimed at whatever was there before. */
  const [before] = useState(lastPointerPress);
  /** The question whose `Other…` was just chosen with a pointer, so its text
   *  box takes the focus as it appears. A key that moves the selection onto
   *  `Other…` keeps the focus where it is. */
  const wantsFocus = useRef<string | null>(null);
  const entry = useLiveEntry();

  const pickOf = (q: Question) => picks[q.id] ?? startPick(q);
  const change = (q: Question, next: (pick: Picked) => Picked) =>
    setPicks((prev) => ({ ...prev, [q.id]: next(prev[q.id] ?? startPick(q)) }));

  // Not to be sent until every question of the call has arrived
  // (`Batch.missing`): the host takes a part of a call's answers and goes on
  // waiting for the rest, which this block would then have no way to ask.
  // A part the host's own list named is held for the rest only so long
  // (`Batch.until`): the block is drawn again when that wait is over.
  const waitOver = batch.missing > 0 ? batch.until : undefined;
  const [, redraw] = useState(0);
  useEffect(() => {
    if (waitOver === undefined) return;
    const left = waitOver - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => redraw((n) => n + 1), left + 20);
    return () => clearTimeout(timer);
  }, [waitOver]);
  const reason = submitReason(questions, picks, stillMissing(batch, Date.now()));
  const total = questions.length;

  // Out of view, the row above the composer says this block is waiting.
  useEffect(() => {
    const el = root.current;
    return el ? watchBlock(batch.key, el, total) : undefined;
  }, [batch.key, total]);

  const submit = async () => {
    if (sending || reason) return;
    setSending(true);
    setError(null);
    const answers = questions.map((q) => ({ id: q.id, answer: pickAnswer(q, pickOf(q)) }));
    try {
      const receipt = await submitQuestionAnswers((command, args) => bridge.invoke(command, args), answers);
      onSent({ ids: answers.map((a) => a.id), items: questions.map((q, i) => ({ question: q.question, answer: answers[i].answer })), receipt });
      // An older host keeps no record: its answers are gone from the list now.
      if (receipt === "delivered") onDone(answers.map((a) => a.id));
    } catch (failure) {
      if (failure instanceof PartialQuestionSubmission) onDone(failure.deliveredIds);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  };

  const dismiss = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await cancelQuestions(questions.map((q) => q.id));
      onDone(questions.map((q) => q.id));
    } catch (failure) {
      if (failure instanceof PartialQuestionSubmission) onDone(failure.deliveredIds);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  };

  /** A press on an answering control: not one that repeats the press made
   *  before the block was here. */
  const guarded = (act: () => void) => (event: React.MouseEvent) => {
    if (strayAnswer(before, { x: event.clientX, y: event.clientY, at: performance.now(), detail: event.detail })) {
      event.preventDefault();
      return;
    }
    act();
  };

  const off = sending || !!reason;
  return (
    <div
      ref={root}
      className={`qa-block ${entry}`}
      role="group"
      aria-label={total === 1 ? "The agent has a question" : `The agent has ${total} questions`}
      aria-busy={sending}
    >
      {questions.map((question, index) => {
        const options = choicesOf(question.options);
        const many = !!question.multiple && options.length > 0;
        const pick = pickOf(question);
        const titleId = `${uid}-q${index}`;
        const name = `${uid}-n${index}`;
        const typed = (
          <input
            className="qa-input"
            type="text"
            value={pick.text}
            disabled={sending}
            aria-label={options.length ? `Other answer to: ${question.question}` : `Answer to: ${question.question}`}
            placeholder="Your answer"
            ref={(node) => {
              if (!node || wantsFocus.current !== question.id) return;
              wantsFocus.current = null;
              node.focus({ preventScroll: true });
            }}
            onChange={(event) => { const text = event.target.value; change(question, (p) => ({ ...p, text })); }}
          />
        );
        return (
          <div className="qa-q" key={question.id}>
            <p className="qa-q-title" id={titleId}>{question.question}</p>
            {options.length === 0 ? typed : (
              <div className="qa-rows" role={many ? "group" : "radiogroup"} aria-labelledby={titleId}>
                {options.map((choice, at) => {
                  const on = many ? pick.ticks.includes(choice.label) : !pick.other && pick.chosen === choice.label;
                  return (
                    <label className="qa-row" key={at}>
                      <input
                        type={many ? "checkbox" : "radio"}
                        name={name}
                        checked={on}
                        disabled={sending}
                        onChange={() => change(question, (p) => many
                          ? { ...p, ticks: togglePick(p.ticks, choice.label) }
                          : { ...p, chosen: choice.label, other: false })}
                      />
                      <span className="qa-mark" aria-hidden="true" />
                      <span className="qa-row-copy">
                        <span className="qa-row-label">
                          {choice.label}
                          {/* Said in words, not colour alone: the mark has to
                              survive a screen reader and a colourblind reader. */}
                          {at === question.recommended && <span className="qa-tip">Recommended</span>}
                        </span>
                        {/* Never sent as the answer: the agent matches what it is
                            told was chosen against what it offered. */}
                        {choice.description && <span className="qa-row-desc">{choice.description}</span>}
                      </span>
                    </label>
                  );
                })}
                {/* Always the last row: "neither" is a real answer, and a
                    question that can only be answered one of two ways is a trap. */}
                <label className="qa-row is-other">
                  <input
                    type={many ? "checkbox" : "radio"}
                    name={name}
                    checked={pick.other}
                    disabled={sending}
                    onClick={(event) => { if (event.detail > 0) wantsFocus.current = question.id; }}
                    onChange={() => change(question, (p) => ({ ...p, other: many ? !p.other : true }))}
                  />
                  <span className="qa-mark" aria-hidden="true" />
                  <span className="qa-row-copy"><span className="qa-row-label">Other…</span></span>
                </label>
                {pick.other && <div className="qa-other">{typed}</div>}
              </div>
            )}
          </div>
        );
      })}

      {error && <p className="qa-note" data-tone="warn" role="alert">{error}</p>}
      <button
        type="button"
        className="qa-submit"
        aria-disabled={off}
        aria-describedby={reason ? `${uid}-why` : undefined}
        onKeyDown={dropHeld}
        onClick={guarded(() => void submit())}
      >
        {sending ? "Sending…" : total === 1 ? "Send answer" : `Send ${total} answers`}
      </button>
      {/* The reason is under the button, so nothing above it moves when the
          last question gets its answer. */}
      <div className="qa-foot">
        <p className="qa-why" id={`${uid}-why`}>{reason ?? ""}</p>
        <button
          type="button"
          className="qa-dismiss"
          aria-disabled={sending}
          title="The agent is told you did not answer"
          onKeyDown={dropHeld}
          onClick={guarded(() => void dismiss())}
        >
          Dismiss without answering
        </button>
      </div>
    </div>
  );
}

/** Close questions without an answer, on a host old or new. */
async function cancelQuestions(ids: string[]): Promise<void> {
  try {
    await bridge.invoke("question_cancel", { ids });
  } catch (failure) {
    if (!missingQuestionCommand(failure, "question_cancel")) throw failure;
    await submitLegacyQuestionAnswers(
      (command, args) => bridge.invoke(command, args),
      ids.map((id) => ({ id, answer: DECLINED })),
    );
  }
}

/* ---- Answered ------------------------------------------------------------- */

/** The answer, as the person's bubble. Not a message: nothing on it acts. */
export function AnswerBubble({ lines, status }: { lines: readonly Said[]; status?: string }) {
  if (!lines.length) return null;
  return (
    <div className="qa-said">
      <div className="qa-said-body" role="note" aria-label="Your answer">
        {lines.map((line, index) => (
          <p className={line.none ? "qa-said-line is-none" : "qa-said-line"} key={index}>
            {line.label && <span className="qa-said-q">{saidLabel(line.label)} </span>}
            {line.answer}
          </p>
        ))}
      </div>
      {status && <p className="qa-said-status">{status}</p>}
    </div>
  );
}

/** A question as a bubble line's label: its own closing mark, or a colon. */
function saidLabel(label: string): string {
  const text = label.trim();
  return /[?？:：!！.。]$/.test(text) ? text : `${text}:`;
}

type Note = { title: string; tone: "quiet" | "warn"; why?: string };

/** The questions once they ask nothing: a quiet line each, and what became
 *  of the answers when that is not simply "answered". */
function Asked({ items, note, children }: {
  items: readonly Pick<AskItem, "question">[];
  note?: Note | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="qa-asked">
      <span className="qa-asked-label">{items.length === 1 ? "Asked" : `Asked ${items.length} questions`}</span>
      {items.map((item, index) => <p className="qa-asked-q" key={index}>{item.question}</p>)}
      {note && (
        <div className="qa-note" data-tone={note.tone} role={note.tone === "warn" ? "status" : undefined}>
          <span>{note.title}</span>
          {/* The reason is the host's sentence, behind a disclosure: the
              answers did arrive, so it is not drawn as an error. */}
          {note.why && <details className="qa-note-why"><summary>Why</summary><p>{note.why}</p></details>}
        </div>
      )}
      {children}
    </div>
  );
}

/** What a receipt says of answers this page just sent, until the host's own
 *  word arrives. Delivered and not saved is its own outcome, said as that. */
function receiptNote(receipt: QuestionReceipt): Note | null {
  if (receipt === "saved") return { title: "Answers saved · waiting for the agent", tone: "quiet" };
  if (receipt === "delivered") return null;
  return { title: "Answers sent · not saved", tone: "warn", why: receipt.unsaved || undefined };
}

/** Answers the host still lists: saved and on their way, sent and not saved,
 *  or not delivered. Each keeps its own words, and the two things that can
 *  still be done about a delivery. */
function Recorded({ batch, onDone }: { batch: Batch; onDone: (ids: string[]) => void }) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = batch.questions.map((q) => q.id);
  const note = answeredNote(batch);
  const failed = batch.questions.some((q) => q.error && q.retryable !== false);
  const act = async (run: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    setError(null);
    try { await run(); } catch (failure) {
      if (failure instanceof PartialQuestionSubmission) onDone(failure.deliveredIds);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setWorking(false); }
  };
  const items = batch.questions.map((q) => ({ question: q.question, answer: q.answer ?? "" }));
  return (
    <>
      <Asked items={items} note={note}>
        {error && <p className="qa-note" data-tone="warn" role="alert">{error}</p>}
        <div className="qa-asked-actions">
          {failed && (
            <button type="button" className="qa-link" aria-disabled={working} onKeyDown={dropHeld}
              onClick={() => void act(() => bridge.invoke("question_retry", { ids }).then(() => {}))}>
              Retry delivery
            </button>
          )}
          <button type="button" className="qa-link" aria-disabled={working} onKeyDown={dropHeld}
            onClick={() => void act(async () => { await cancelQuestions(ids); onDone(ids); })}>
            Cancel pending delivery
          </button>
        </div>
      </Asked>
      <AnswerBubble lines={saidLines(items)} />
    </>
  );
}

/** The keys a badge in the chat list finds this block by (`lib/pendingActions`). */
function pendingKeys(batch: Batch | undefined): string | undefined {
  if (!batch) return undefined;
  return [...questionActions(batch.questions)].map(([identity, kind]) => `${kind}:${identity}`).join(" ") || undefined;
}

/** One batch, by what the host says of it: asking, or answered and waiting.
 *
 *  Drawn part by part (`batchParts`). What has an answer is a quiet line
 *  and the person's bubble; what has none is asked, whatever this page sent
 *  before. `sent` is this page's own memory of an answer it just sent: it
 *  is read only for the questions it was sent for, so a question that
 *  arrives afterwards, or one a saved record still holds open, is drawn and
 *  can be answered. */
function BatchView({ batch, onDone, sent, onSent }: {
  batch: Batch;
  onDone: (ids: string[]) => void;
  sent: Sent | null;
  onSent: (sent: Sent) => void;
}) {
  if (!asks(batch)) return <Recorded batch={batch} onDone={onDone} />;
  const { said, open } = batchParts(batch, sent?.ids);
  // What is answered so far, in the order asked: the host's answer when it
  // holds one, else what this page sent and has not heard back about.
  const items = said.map((q) => {
    const mine = sent ? sent.ids.indexOf(q.id) : -1;
    return { question: q.question, answer: q.answer ?? (mine >= 0 ? sent!.items[mine]?.answer ?? "" : "") };
  });
  const heard = said.every((q) => q.answer !== undefined);
  // Sent from here, all of it, and the host's own word has not arrived yet.
  if (!open.length) return <><Asked items={items} note={sent ? receiptNote(sent.receipt) : null} /><AnswerBubble lines={saidLines(items)} /></>;
  return (
    <>
      {items.length > 0 && <>
        <Asked items={items} note={!heard && sent && sent.receipt !== "saved" ? receiptNote(sent.receipt) : partNote(items.length, open.length)} />
        <AnswerBubble lines={answeredLines(items)} />
      </>}
      <QuestionForm batch={batch} questions={open} onDone={onDone} onSent={onSent} />
    </>
  );
}

/** The bubble of a part of a call: each answer with its question, one
 *  answer too, because the block under it asks the others. */
function answeredLines(items: readonly AskItem[]): Said[] {
  return items.filter((item) => item.answer).map((item) => ({ label: item.question, answer: item.answer }));
}

/** A delivered question, from the line the host wrote into the chat's
 *  record: what was asked, quietly, and the person's bubble. Drawn where
 *  the line stands unless a call of the transcript is this question's, and
 *  then the call draws it and this draws nothing. Read-only: a record. */
export function AnsweredInline({ answered }: { answered: QuestionAnswered }) {
  const places = useContext(AnsweredPlacesContext);
  if (places && !places.atLine.has(answered.id)) return null;
  const items = answeredItems(answered);
  return (
    <div className="qa-turn is-answered" data-answered={answered.id}>
      <Asked items={items} />
      <AnswerBubble lines={saidLines(items)} />
    </div>
  );
}

/* ---- At the call that asked ----------------------------------------------- */

/** An `ask_user` call in the transcript: its questions while they wait, and
 *  the answer once there is one. `asked` is the call read by
 *  `lib/askAnswer`; `null` while its arguments are still arriving. */
export function AskInline({ toolId, asked, late }: {
  toolId: string;
  asked: AskItem[] | null;
  /** The answer that came back after this call ended, when there is one. */
  late: AskItem[] | null;
}) {
  const places = useContext(AskPlacesContext);
  const batch = places?.placement.byTool.get(toolId);
  // The host's own line for this call's answers, when the record holds one.
  const recorded = useContext(AnsweredPlacesContext)?.byTool.get(toolId) ?? null;
  const [sent, setSent] = useState<Sent | null>(null);
  const entry = useLiveEntry("enter-fade");
  const onDone = places?.onDone ?? (() => {});

  let body: React.ReactNode;
  if (batch) {
    body = <BatchView batch={batch} onDone={onDone} sent={sent} onSent={(next) => setSent((before) => alsoSent(before, next))} />;
  } else if (!asked) {
    body = <p className={`qa-asking ${entry}`}>Asking a question…</p>;
  } else if (asked.some((item) => item.answer)) {
    // What the person said, from the call's own result.
    body = <><Asked items={asked} /><AnswerBubble lines={saidLines(asked)} /></>;
  } else if (recorded) {
    // Handed over while the call waited: the host's line says what, before
    // the call's result does and in every tab.
    body = <><Asked items={recorded} /><AnswerBubble lines={saidLines(recorded)} /></>;
  } else if (sent && !asked.some((item) => item.unanswered)) {
    // Answered from this page a moment ago; the call's result is on its way.
    body = <><Asked items={sent.items} note={receiptNote(sent.receipt)} /><AnswerBubble lines={saidLines(sent.items)} /></>;
  } else if (late) {
    // The call ended still waiting; the answer is the host's turn further down.
    body = <Asked items={late} note={{ title: "Answered later in this conversation", tone: "quiet" }} />;
  } else {
    const none = asked.find((item) => item.unanswered)?.unanswered;
    body = <Asked items={asked} note={none ? { title: none[0].toUpperCase() + none.slice(1), tone: "quiet" } : null} />;
  }
  return (
    <div className="pending-target" data-pending-keys={pendingKeys(batch)}>
      <div className="qa-turn">{body}</div>
    </div>
  );
}

/** Pending batches with no call in the transcript the page holds, at its end. */
export function LooseQuestions() {
  const places = useContext(AskPlacesContext);
  if (!places?.placement.loose.length) return null;
  return (
    <>
      {places.placement.loose.map((batch) => <LooseBatch key={batch.key} batch={batch} onDone={places.onDone} />)}
    </>
  );
}

function LooseBatch({ batch, onDone }: { batch: Batch; onDone: (ids: string[]) => void }) {
  const [sent, setSent] = useState<Sent | null>(null);
  return (
    <div className="pending-target" data-pending-keys={pendingKeys(batch)}>
      <div className="qa-turn is-loose">
        <BatchView batch={batch} onDone={onDone} sent={sent} onSent={(next) => setSent((before) => alsoSent(before, next))} />
      </div>
    </div>
  );
}

/* ---- The row above the composer -------------------------------------------- */

/** `1 question waiting`, while a block that still asks is out of view. A row
 *  of the composer's group (`components/ChatStatus`); pressing it goes to the
 *  block and puts the keyboard on its first control. */
export function QuestionWaitingRow() {
  const hidden = useSyncExternalStore(subscribeSight, hiddenNow, () => 0);
  if (!hidden) return null;
  return (
    <div className="status-row qa-waiting">
      <button type="button" className="status-row-main" onClick={() => { revealWaiting(); }}>
        <span className="status-row-icon" data-tone="decide" aria-hidden="true"><span className="qa-waiting-dot" /></span>
        <span className="status-row-label">{waitingLabel(hidden)}</span>
        <span className="status-row-text">Show</span>
      </button>
    </div>
  );
}
