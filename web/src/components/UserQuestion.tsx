// The agent asking you something — or several things at once.
//
// Print mode is never offered AskUserQuestion, so these arrive through a tool
// of our own (scripts/mcp/octiq-ask.cjs). The agent is blocked on every one of
// them: it asked because the decision is yours, and it will not guess while it
// waits.
//
// An agent can ask more than one thing in a single turn — Claude batches
// independent tool calls. A batch stays ONE card, but it is read a PAGE AT A
// TIME: one question on screen, arrows and a row of dots underneath. Five
// questions drawn out at once is a wall taller than the window, and the
// scrolling it takes to reach the last one is exactly what makes the first one
// feel already decided. Nothing goes back to the agent until the single Submit
// at the end — paging is only how it is read, and answers are kept per
// question, so stepping back shows what was already picked. Answering piecemeal
// must never let the agent act on the first answer while you are still deciding
// the third.
//
// So a batch of four is FOUR pages AND A FIFTH: the button under a question
// page reads Next and only turns the page, and the last page is the answers
// laid out together with the one button that sends them. Two things follow from
// that. The way forward is the same button every time — you are never hunting
// for whether this page is the one that sends — and the send is only ever
// pressed with the whole set in front of you, which is the read a batch needed
// and paging had taken away. Press any line of the review to go back and change
// it. A single question keeps its single page: a review of one answer is a
// second press for nothing.
//
// Options when there are options, a text box when there are not — "which of
// these two" and "what should it be called" are different questions and a
// single control would serve one of them badly. A question the agent marks as
// taking a SET is a third: its options tick on and off and are sent together.
//
// And the card ARRIVES put aside — a strip naming what is waiting, not the
// question opened out. The answer is nearly always in the conversation the card
// would be sitting on top of: what the agent just did, what it just read. Drawn
// open it took that away at the exact moment it was needed, and the way back to
// it was to minimise a card that had just been opened for you. So the strip is
// the arrival state and pressing it is the choice to answer now. Nothing about
// this decides anything — with the agent blocked, the only other way to clear
// the card was to close it, and closing IS an answer.
//
// Being missed is not the risk it looks like: a question is announced when it
// arrives (announceOnce in App.tsx), and the strip keeps the pulsing dot.
import { useState } from "react";
import { bridge } from "../lib/bridge";
import { choicesOf, optionIsOn, pendingAnswer, togglePick } from "../lib/questionAnswer";
import type { Choice } from "../lib/questionAnswer";
import { RollingText } from "./RollingNumber";

export type Question = {
  id: string;
  chatKey?: string;
  question: string;
  /** What is on offer. Read through choicesOf, never straight: an agent sends
   *  AskUserQuestion-shaped {label, description} objects, an older server
   *  sends plain strings, and both have to draw. */
  options?: (string | Choice)[];
  /** Index into options of the one the agent would pick. Advisory only: it is
   *  marked, never pre-selected, and closing without answering still sends
   *  DECLINED rather than this. The agent having a view does not make the
   *  decision less yours — it just saves you working out which one it meant. */
  recommended?: number;
  /** Whether several of options may be picked at once. The agent asks for it
   *  per question: it is the only one that knows whether it can act on a set. */
  multiple?: boolean;
  /** A uuid shared by every question of the same `ask_user` call, present only
   *  when that call carried more than one. The card itself has no use for
   *  it — it already draws every pending question of the conversation as one
   *  card — this is for App.tsx, so it can announce the call once rather than
   *  once per question. */
  batch?: string;
  /** How many questions the call this one belongs to carried. Present only
   *  alongside `batch`. */
  batchSize?: number;
};

/** What it says when you close the card instead of answering.
 *
 *  Closing is an answer, not a disappearance: the agent is blocked, so
 *  dismissing without replying would leave it waiting out the full timeout
 *  having been told nothing. Worded like the timeout message so it does not
 *  invent a preference you never expressed. */
const DECLINED =
  "The user closed this question without answering. Do not assume an answer — " +
  "say what you need and stop, or continue in a way that does not depend on it.";

export function UserQuestion({
  questions,
  onDone,
  startOpen = false,
  startPage = 0,
}: {
  questions: Question[];
  onDone: (ids: string[]) => void;
  /** Draw it open instead of as the strip. Off everywhere in the app — a
   *  question always arrives put aside — and on in the tests, which render
   *  static markup in node and so cannot press the strip themselves. */
  startOpen?: boolean;
  /** Which page to open on. Zero everywhere in the app — a batch is read from
   *  the first question — and set in the tests, for the same reason as
   *  `startOpen`: static markup cannot press Next to reach the review. */
  startPage?: number;
}) {
  const [selected, setSelected] = useState<Record<string, string>>({});
  /** Ticks so far, per question. Kept apart from the final answer because a
   *  set is not an answer until it is confirmed. */
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [text, setText] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  /** Put aside from the moment it appears — see the note at the top of the
   *  file. Fresh per batch: the card is keyed on the first question's id, so a
   *  new batch is a new card and starts put aside again, while a question
   *  arriving mid-batch leaves an open card open rather than slamming it shut
   *  under someone mid-answer. */
  const [minimised, setMinimised] = useState(!startOpen);
  /** Which question is on screen. Only ever the page: every answer is stored
   *  against its question's id, so turning the page costs nothing and going
   *  back shows the choice already made. */
  const [page, setPage] = useState(startPage);
  /** Which way the last turn went, so the page slides in from the side it came
   *  from rather than appearing. Read by the stylesheet, nothing else. */
  const [dir, setDir] = useState<"fwd" | "back">("fwd");

  const total = questions.length;
  /** A batch gets one page per question and a last one holding the answers
   *  together; a lone question is its own whole card. */
  const paged = total > 1;
  const pages = paged ? total + 1 : 1;
  // Clamped rather than corrected in an effect: a question can be answered out
  // from under the card by another tab, and a page past the end must not draw
  // an empty card for a frame first.
  const here = Math.min(page, pages - 1);
  /** On the last page: the answers laid out, and the only button that sends. */
  const reviewing = paged && here === total;

  const goto = (next: number) => {
    if (next < 0 || next >= pages || next === here) return;
    setDir(next > here ? "fwd" : "back");
    setPage(next);
  };

  /** What this one question will say when the shared Submit button is pressed.
   *  A text answer still beats a one-of selection; a set still combines ticks
   *  and a typed addition. */
  const answerFor = (question: Question): string => {
    const options = choicesOf(question.options);
    return pendingAnswer({
      many: !!question.multiple && options.length > 0,
      labels: options.map((option) => option.label),
      ticked: picks[question.id] ?? [],
      chosen: selected[question.id],
      text: text[question.id] ?? "",
    });
  };

  const answers = questions.reduce<Record<string, string>>((all, question) => {
    const answer = answerFor(question);
    if (answer) all[question.id] = answer;
    return all;
  }, {});
  const answered = Object.keys(answers).length;

  /** Select a choice, or take the selection back.
   *
   *  Both halves matter. Selecting used to SEND, which is what made a mis-tap
   *  final; a second tap undoing it is what makes the first one cost nothing. */
  const choose = (question: Question, label: string) => {
    setSelected((prev) => {
      if (prev[question.id] !== label) return { ...prev, [question.id]: label };
      const rest = { ...prev };
      delete rest[question.id];
      return rest;
    });
  };

  /** Everything at once, so the agent sees a complete set rather than starting
   *  on the first answer while you are still deciding the third. */
  const submit = async (values: Record<string, string>) => {
    if (sending) return;
    setSending(true);
    const ids = questions.map((question) => question.id);
    await Promise.all(
      ids.map((id) =>
        bridge
          .invoke("question_answer", { id, answer: values[id] ?? DECLINED })
          // Expired while you were deciding; either way it is answered or gone.
          .catch(() => undefined),
      ),
    );
    onDone(ids);
  };

  // Put aside — which is how it arrives, and where it goes back to on the "–".
  // A strip naming what is waiting, leaving the transcript beneath it — usually
  // where the answer is — on screen. Nothing is sent and nothing is lost: the
  // ticks and typed lines are still here when the strip is pressed.
  if (minimised) {
    return (
      <div className="qa-card is-min">
        <button
          className="qa-restore"
          type="button"
          title="Back to the questions"
          onClick={() => setMinimised(false)}
        >
          <span className="qa-dot" aria-hidden="true" />
          <span className="qa-min-copy">
            <span className="qa-min-title">Claude is asking</span>
            <span className="qa-min-q">{questions[0]?.question ?? "For your answers"}</span>
          </span>
          {total > 1 && (
            <span className="qa-count">
              <RollingText>{total + " questions"}</RollingText>
            </span>
          )}
          <span className="qa-min-cue">Answer</span>
        </button>
      </div>
    );
  }

  /** One button in one place, all the way through: it turns the page until
   *  there are no pages left, and on the review it sends. A batch can only be
   *  sent from the page that shows the whole batch, so it is not possible to
   *  send from page two having forgotten pages three to five. It still says how
   *  many of how many — what is not answered goes back as declined, not as
   *  nothing.
   *
   *  It rides in the pager row rather than under it, so the way forward and the
   *  way back are one row of controls and the answer above them is the only
   *  other thing on the card. */
  const cta =
    reviewing || !paged ? (
      <button
        className="ask-btn is-primary qa-submit"
        type="button"
        disabled={sending || answered === 0}
        onClick={() => void submit(answers)}
      >
        {sending
          ? "Sending…"
          : answered === 0
            ? "Send answers"
            : paged
              ? "Send " + answered + " of " + total + " answers"
              : "Send " + answered + " answer" + (answered === 1 ? "" : "s")}
      </button>
    ) : (
      // Never disabled on an unanswered question: skipping one and coming back
      // to it is a way of reading the batch, and a dead button here would read
      // as the card refusing to go on.
      <button
        className="ask-btn is-primary qa-submit qa-next"
        type="button"
        disabled={sending}
        onClick={() => goto(here + 1)}
      >
        {here === total - 1 ? "Review answers" : "Next question"}
      </button>
    );

  return (
    <div
      className="qa-card"
      role="alertdialog"
      aria-label={total === 1 ? "The agent has a question" : "The agent has " + total + " questions"}
    >
      <div className="qa-head">
        <span className="qa-dot" aria-hidden="true" />
        <span className="qa-label">Claude is asking</span>
        {total > 1 && (
          <span className="qa-count">
            <RollingText>{total + " questions"}</RollingText>
          </span>
        )}
        {/* Not a close. The agent is blocked, so closing is an answer — and
            the answer is often in the conversation this card is covering. */}
        <button
          className="qa-min-btn"
          type="button"
          disabled={sending}
          title="Hide while you read"
          aria-label="Hide this question while you read the conversation"
          onClick={() => setMinimised(true)}
        >
          –
        </button>
        <button
          className="qa-close"
          type="button"
          disabled={sending}
          title="Close without answering"
          aria-label="Close without answering"
          onClick={() => void submit({})}
        >
          ×
        </button>
      </div>

      <div className="qa-questions">
        {/* The last page of a batch: everything you decided, in one read, with
            the send under it. Each line goes back to its own question, so
            changing an answer here is a press rather than a hunt. */}
        {reviewing && (
          <section className={"qa-question-item qa-review is-" + dir}>
            <div className="qa-question-number">Review</div>
            <p className="qa-question">Your answers</p>
            <p className="qa-hint">
              Press a line to change it. Anything still blank goes back as declined.
            </p>
            <ul className="qa-review-list">
              {questions.map((question, index) => {
                const answer = answers[question.id];
                return (
                  <li key={question.id}>
                    <button
                      className={"qa-review-row " + (answer ? "" : "is-blank")}
                      type="button"
                      disabled={sending}
                      title={"Back to question " + (index + 1)}
                      onClick={() => goto(index)}
                    >
                      <span className="qa-review-n" aria-hidden="true">
                        {index + 1}
                      </span>
                      <span className="qa-review-copy">
                        <span className="qa-review-q">{question.question}</span>
                        <span className="qa-review-a">{answer ?? "Not answered"}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* One question, never the whole batch. `slice` rather than an index so
            the question keeps its own `key` and the page animates in on the
            remount. */}
        {(reviewing ? [] : questions.slice(here, here + 1)).map((question) => {
          const options = choicesOf(question.options);
          const detailed = options.some((option) => option.description);
          const many = !!question.multiple && options.length > 0;
          const ticked = picks[question.id] ?? [];
          const chosen = selected[question.id];
          const typed = text[question.id] ?? "";

          return (
            <section className={"qa-question-item is-" + dir} key={question.id}>
              {total > 1 && (
                <div className="qa-question-number">
                  Question {here + 1} of {total}
                </div>
              )}
              <p className="qa-question">{question.question}</p>

              {/* Said before the first tap. Neither kind sends on the tap, and a
                  card that waits without saying so reads as a card that ignored
                  you. */}
              {options.length > 0 && (
                <p className="qa-hint">
                  {many ? "Pick as many as you like, or add your own answer" : "Pick one or type another answer"}
                </p>
              )}

              {options.length > 0 && (
                <div
                  className={"qa-options " + (detailed ? "is-detailed" : "")}
                  // One of these is a radio group and the other a set of
                  // checkboxes, and saying which is what tells a screen reader
                  // that pressing one decides nothing yet.
                  role={many ? "group" : "radiogroup"}
                  aria-label={question.question}
                >
                  {options.map((choice, optionIndex) => {
                    // Said in WORDS, not colour alone — the mark has to survive a
                    // screen reader and a colourblind reader, and "the blue one"
                    // is not an answer either of them gets.
                    const tip = optionIndex === question.recommended;
                    // Lit only while it is what the shared Submit button would
                    // send. Type a line and a one-of's choice goes out — what is
                    // typed beats what was tapped.
                    const on = optionIsOn({ many, label: choice.label, ticked, chosen, text: typed });
                    return (
                      <button
                        key={choice.label}
                        className={
                          "qa-option " +
                          (on ? "is-on " : "") +
                          (tip ? "is-tip " : "") +
                          (many ? "is-many " : "") +
                          (detailed ? "is-detailed" : "")
                        }
                        type="button"
                        role={many ? "checkbox" : "radio"}
                        aria-checked={on}
                        disabled={sending}
                        onClick={() =>
                          many
                            ? setPicks((prev) => ({
                                ...prev,
                                [question.id]: togglePick(prev[question.id] ?? [], choice.label),
                              }))
                            : choose(question, choice.label)
                        }
                      >
                        {many && (
                          <span className="qa-tick" aria-hidden="true">
                            {on ? "✓" : ""}
                          </span>
                        )}
                        <span className="qa-option-text">
                          <span className="qa-option-label">
                            {choice.label}
                            {tip && <span className="qa-tip">Suggested</span>}
                          </span>
                          {/* The explanation, when the label alone does not say
                              enough. Never sent as the answer — the agent has to
                              match what it is told was chosen against what it offered. */}
                          {choice.description && (
                            <span className="qa-option-desc">{choice.description}</span>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Always available, even with options: "neither" is a real
                  answer, and a question you can only answer one of two ways is
                  a trap. The shared Submit below is the only thing that sends. */}
              <div className="qa-free">
                <input
                  className="qa-input"
                  value={typed}
                  autoFocus={options.length === 0}
                  aria-label={"Answer to: " + question.question}
                  placeholder={
                    options.length === 0
                      ? "Your answer…"
                      : many
                        ? "…and anything else"
                        : "…or say something else"
                  }
                  disabled={sending}
                  onChange={(event) =>
                    setText((prev) => ({ ...prev, [question.id]: event.target.value }))
                  }
                />
              </div>
            </section>
          );
        })}
      </div>

      {/* Where you are in the batch, and the way through it — one row: back,
          the dots, and the button that goes on. The dots are the whole of the
          progress read: filled is answered, so a glance says what is still
          waiting without turning a single page. The square at the end is the
          review — drawn apart from the questions because it is not one of them,
          and reachable early because a glance at the set so far is a fair thing
          to want on page two.

          There is no forward ARROW: the button beside it already turns the
          page, and two ways forward an inch apart is a decision to make about
          nothing. Back stays an arrow — it is the smaller act, and it is the
          one with no button. */}
      {paged && (
        <div className="qa-pager">
          <button
            className="qa-page-arrow"
            type="button"
            disabled={sending || here === 0}
            title="Previous question"
            aria-label="Previous question"
            onClick={() => goto(here - 1)}
          >
            ‹
          </button>
          <div className="qa-page-dots">
            {questions.map((question, index) => (
              <button
                key={question.id}
                className={
                  "qa-page-dot " +
                  (index === here ? "is-here " : "") +
                  (answers[question.id] ? "is-done" : "")
                }
                type="button"
                disabled={sending}
                aria-current={index === here}
                title={"Question " + (index + 1) + (answers[question.id] ? " — answered" : "")}
                aria-label={
                  "Question " + (index + 1) + (answers[question.id] ? ", answered" : ", unanswered")
                }
                onClick={() => goto(index)}
              />
            ))}
            <button
              className={"qa-page-dot is-review " + (reviewing ? "is-here" : "")}
              type="button"
              disabled={sending}
              aria-current={reviewing}
              title="Review your answers"
              aria-label="Review your answers"
              onClick={() => goto(total)}
            />
          </div>
          {cta}
        </div>
      )}

      {/* A lone question has no pager to sit in, so its send goes under the
          answer on its own. */}
      {!paged && cta}
    </div>
  );
}
