// The agent asking you something — or several things at once.
//
// Print mode is never offered AskUserQuestion, so these arrive through a tool
// of our own (scripts/mcp/octiq-ask.cjs). The agent is blocked on every one of
// them: it asked because the decision is yours, and it will not guess while it
// waits.
//
// An agent can ask more than one thing in a single turn — Claude batches
// independent tool calls. A batch stays ONE card, but every question is open
// in it at once, so related decisions can be compared without paging back and
// forth. Nothing goes back to the agent until the single Submit at the end:
// answering piecemeal must not let it act on the first answer while you are
// still deciding the third.
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

  const total = questions.length;

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
        {questions.map((question, index) => {
          const options = choicesOf(question.options);
          const detailed = options.some((option) => option.description);
          const many = !!question.multiple && options.length > 0;
          const ticked = picks[question.id] ?? [];
          const chosen = selected[question.id];
          const typed = text[question.id] ?? "";

          return (
            <section className="qa-question-item" key={question.id}>
              {total > 1 && <div className="qa-question-number">Question {index + 1}</div>}
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
                  autoFocus={index === 0 && options.length === 0}
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
            : "Send " + answered + " answer" + (answered === 1 ? "" : "s")}
      </button>
    </div>
  );
}
