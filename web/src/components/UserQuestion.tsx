// The agent asking you something — or several things at once.
//
// Print mode is never offered `AskUserQuestion`, so these arrive through a tool
// of our own (scripts/mcp/octiq-ask.cjs). The agent is blocked on every one of
// them: it asked because the decision is yours, and it will not guess while it
// waits.
//
// An agent can ask more than one thing in a single turn — Claude batches
// independent tool calls — and laid out side by side they read as a form dumped
// on you at once. So a batch becomes ONE card, a question to a page, then a
// summary you can correct before anything is sent. Nothing goes back to the
// agent until Submit: answering piecemeal means it starts acting on the first
// answer while you are still deciding the third.
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
// arrives (`announceOnce` in App.tsx), and the strip keeps the pulsing dot.
import { useState } from "react";
import { bridge } from "../lib/bridge";
import { choicesOf, optionIsOn, pendingAnswer, togglePick } from "../lib/questionAnswer";
import type { Choice } from "../lib/questionAnswer";

export type Question = {
  id: string;
  chatKey?: string;
  question: string;
  /** What is on offer. Read through `choicesOf`, never straight: an agent sends
   *  `AskUserQuestion`-shaped `{label, description}` objects, an older server
   *  sends plain strings, and both have to draw. */
  options?: (string | Choice)[];
  /** Index into `options` of the one the agent would pick. Advisory only: it is
   *  marked, never pre-selected, and closing without answering still sends
   *  DECLINED rather than this. The agent having a view does not make the
   *  decision less yours — it just saves you working out which one it meant. */
  recommended?: number;
  /** Whether several of `options` may be picked at once. The agent asks for it
   *  per question: it is the only one that knows whether it can act on a set. */
  multiple?: boolean;
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
}: {
  questions: Question[];
  onDone: (ids: string[]) => void;
  /** Draw it open instead of as the strip. Off everywhere in the app — a
   *  question always arrives put aside — and on in the tests, which render
   *  static markup in node and so cannot press the strip themselves. */
  startOpen?: boolean;
}) {
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  /** Ticks so far, per question. Kept apart from `answers` because a set is not
   *  an answer until it is confirmed — and stepping back to a question has to
   *  find its ticks where they were, not a sentence to re-read. */
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  /** Put aside from the moment it appears — see the note at the top of the
   *  file. Fresh per batch: the card is keyed on the first question's id, so a
   *  new batch is a new card and starts put aside again, while a question
   *  arriving mid-batch leaves an open card open rather than slamming it shut
   *  under someone mid-answer. */
  const [minimised, setMinimised] = useState(!startOpen);

  const total = questions.length;
  // One page per question, plus a summary — but a single question needs no
  // summary of itself, so it submits from its own page.
  const summaryPage = total > 1 ? total : -1;
  const onSummary = page === summaryPage;
  const current = onSummary ? undefined : questions[page];
  const answered = questions.filter((q) => answers[q.id]).length;

  const options = choicesOf(current?.options);
  // What an answer is made of. A description explains a choice; it is never
  // part of what the agent is told was chosen.
  const labels = options.map((o) => o.label);
  // A description turns the pills into rows: a line of explanation cannot wrap
  // sideways next to the next choice along and still read as belonging to this
  // one.
  const detailed = options.some((o) => o.description);
  // A set needs something to make a set of. Marked as taking several with no
  // options to tick, the question is a text box like any other.
  const many = !!current?.multiple && options.length > 0;
  const ticked = current ? picks[current.id] ?? [] : [];
  /** The one selected on this page, or the answer already recorded for it. */
  const chosen = current ? answers[current.id] : undefined;
  // What the button would send. Nothing is sent without pressing it — see
  // `pendingAnswer` for why a tap decides nothing on its own.
  const pending = pendingAnswer({ many, labels, ticked, chosen, text });
  /** The word on the button, said again in the hint above the choices so that
   *  the two-step is stated rather than discovered. */
  const sendLabel = page + 1 === total && summaryPage < 0 ? "Answer" : "Next";

  /** Select a choice, or take the selection back.
   *
   *  Both halves matter. Selecting used to SEND, which is what made a mis-tap
   *  final; a second tap undoing it is what makes the first one cost nothing. */
  const choose = (q: Question, label: string) => {
    setAnswers((prev) => {
      if (prev[q.id] !== label) return { ...prev, [q.id]: label };
      const rest = { ...prev };
      delete rest[q.id];
      return rest;
    });
  };

  const record = (q: Question, value: string) => {
    const said = value.trim();
    if (!said) return;
    const next = { ...answers, [q.id]: said };
    setAnswers(next);
    setText("");
    // A lone question has nothing to review, so answering it IS submitting.
    // Advancing instead would leave the card on a page that does not exist.
    if (total === 1) {
      void submit(next);
      return;
    }
    setPage((p) => p + 1);
  };

  /** Everything at once, so the agent sees a complete set rather than starting
   *  on the first answer while you are still deciding the third. */
  const submit = async (values: Record<string, string>) => {
    if (sending) return;
    setSending(true);
    const ids = questions.map((q) => q.id);
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
  // ticks, the typed line and the page are all still here when the strip is
  // pressed.
  if (minimised) {
    return (
      <div className="qa-card is-min">
        <button
          className="qa-restore"
          type="button"
          title="Back to the question"
          onClick={() => setMinimised(false)}
        >
          <span className="qa-dot" aria-hidden="true" />
          <span className="qa-label">Claude is asking</span>
          <span className="qa-min-q">{current?.question ?? "for your answers"}</span>
          {/* A second question can arrive while the card is put aside, and the
              strip is then the only thing saying so. */}
          {total > 1 && <span className="qa-count">{`${page + 1} of ${total}`}</span>}
          <span className="qa-min-cue">{onSummary ? "Review" : "Answer"}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="qa-card" role="alertdialog" aria-label="The agent has a question">
      <div className="qa-head">
        <span className="qa-dot" aria-hidden="true" />
        <span className="qa-label">Claude is asking</span>
        {total > 1 && (
          <span className="qa-count">
            {onSummary ? "Review" : `${page + 1} of ${total}`}
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

      {current && (
        <>
          <p className="qa-question">{current.question}</p>

          {/* Said before the first tap. Neither kind sends on the tap, and a
              card that waits without saying so reads as a card that ignored
              you. */}
          {options.length > 0 && (
            <p className="qa-hint">
              {many ? "Pick as many as you like" : `Pick one, then press ${sendLabel}`}
            </p>
          )}

          {options.length > 0 && (
            <div
              className={`qa-options ${detailed ? "is-detailed" : ""}`}
              // One of these is a radio group and the other a set of
              // checkboxes, and saying which is what tells a screen reader
              // that pressing one decides nothing yet.
              role={many ? "group" : "radiogroup"}
            >
              {options.map((choice, i) => {
                // Said in WORDS, not colour alone — the mark has to survive a
                // screen reader and a colourblind reader, and "the blue one"
                // is not an answer either of them gets.
                const tip = i === current.recommended;
                // Lit only while it is what the button would send. Type a line
                // and a one-of's choice goes out — what is typed beats what was
                // tapped, and a choice still lit beside it claims a decision
                // that is not the one being sent.
                const on = optionIsOn({ many, label: choice.label, ticked, chosen, text });
                return (
                  <button
                    key={choice.label}
                    className={`qa-option ${on ? "is-on" : ""} ${tip ? "is-tip" : ""} ${
                      many ? "is-many" : ""
                    } ${detailed ? "is-detailed" : ""}`}
                    type="button"
                    role={many ? "checkbox" : "radio"}
                    aria-checked={on}
                    disabled={sending}
                    onClick={() =>
                      many
                        ? setPicks((prev) => ({
                            ...prev,
                            [current.id]: togglePick(prev[current.id] ?? [], choice.label),
                          }))
                        : choose(current, choice.label)
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
                          match what it is told against what it offered. */}
                      {choice.description && (
                        <span className="qa-option-desc">{choice.description}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Always available, even with options: "neither" is a real answer,
              and a question you can only answer one of two ways is a trap. */}
          <form
            className="qa-free"
            onSubmit={(e) => {
              e.preventDefault();
              record(current, pending);
            }}
          >
            <input
              className="qa-input"
              value={text}
              autoFocus={options.length === 0}
              placeholder={
                options.length === 0
                  ? "Your answer…"
                  : many
                    ? "…and anything else"
                    : "…or say something else"
              }
              disabled={sending}
              onChange={(e) => setText(e.target.value)}
            />
            {/* Every question is sent by this button and not by its choices, so
                it stays pressable on a selection alone — with nothing typed
                there would otherwise be no way to send what you picked. */}
            <button className="ask-btn" type="submit" disabled={sending || !pending}>
              {sendLabel}
            </button>
          </form>
        </>
      )}

      {onSummary && (
        <div className="qa-summary">
          {questions.map((q, i) => (
            <button
              key={q.id}
              className="qa-review"
              type="button"
              disabled={sending}
              // Correcting is going back to the question, not editing a copy of
              // the answer — the wording of the question is half the decision.
              title="Change this answer"
              onClick={() => setPage(i)}
            >
              <span className="qa-review-q">{q.question}</span>
              <span className={`qa-review-a ${answers[q.id] ? "" : "is-empty"}`}>
                {answers[q.id] ?? "not answered"}
              </span>
            </button>
          ))}

          <button
            className="ask-btn is-primary qa-submit"
            type="button"
            disabled={sending || answered === 0}
            onClick={() => void submit(answers)}
          >
            {sending ? "Sending…" : `Send ${answered} answer${answered === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      {total > 1 && page > 0 && (
        <button className="qa-back" type="button" disabled={sending} onClick={() => setPage((p) => p - 1)}>
          ← Back
        </button>
      )}
    </div>
  );
}
