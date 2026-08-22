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
// And the card can be put aside. The answer is often in the conversation the
// card is sitting on top of — what the agent just did, what it just read — and
// with the agent blocked the only other way back to it was to close the card,
// which is itself an answer. Minimising decides nothing.
import { useState } from "react";
import { bridge } from "../lib/bridge";
import { composeAnswer, togglePick } from "../lib/questionAnswer";

export type Question = {
  id: string;
  chatKey?: string;
  question: string;
  options?: string[];
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
}: {
  questions: Question[];
  onDone: (ids: string[]) => void;
}) {
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  /** Ticks so far, per question. Kept apart from `answers` because a set is not
   *  an answer until it is confirmed — and stepping back to a question has to
   *  find its ticks where they were, not a sentence to re-read. */
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [minimised, setMinimised] = useState(false);

  const total = questions.length;
  // One page per question, plus a summary — but a single question needs no
  // summary of itself, so it submits from its own page.
  const summaryPage = total > 1 ? total : -1;
  const onSummary = page === summaryPage;
  const current = onSummary ? undefined : questions[page];
  const answered = questions.filter((q) => answers[q.id]).length;

  const options = current?.options ?? [];
  // A set needs something to make a set of. Marked as taking several with no
  // options to tick, the question is a text box like any other.
  const many = !!current?.multiple && options.length > 0;
  const ticked = current ? picks[current.id] ?? [] : [];
  // What the current page would send: the ticks and anything typed beside them
  // for a set, the typed line on its own otherwise.
  const pending = many ? composeAnswer(options, ticked, text) : text.trim();

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

  // Put aside. The card shrinks to a strip naming what is waiting, and the
  // transcript underneath — usually where the answer is — comes back into view.
  // Nothing is sent and nothing is lost: the ticks, the typed line and the page
  // are all still here when the strip is pressed.
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

          {/* Said before the first tap, because the two behave differently:
              one choice answers on the spot, a set waits to be sent. */}
          {many && <p className="qa-hint">Pick as many as you like</p>}

          {options.length > 0 && (
            <div className="qa-options" role={many ? "group" : undefined}>
              {options.map((option, i) => {
                // Said in WORDS, not colour alone — the mark has to survive a
                // screen reader and a colourblind reader, and "the blue one"
                // is not an answer either of them gets.
                const tip = i === current.recommended;
                const on = many ? ticked.includes(option) : answers[current.id] === option;
                return (
                  <button
                    key={option}
                    className={`qa-option ${on ? "is-on" : ""} ${tip ? "is-tip" : ""} ${
                      many ? "is-many" : ""
                    }`}
                    type="button"
                    // A tick is a checkbox, and saying so is what tells a
                    // screen reader that pressing it decides nothing yet.
                    role={many ? "checkbox" : undefined}
                    aria-checked={many ? on : undefined}
                    disabled={sending}
                    onClick={() =>
                      many
                        ? setPicks((prev) => ({
                            ...prev,
                            [current.id]: togglePick(prev[current.id] ?? [], option),
                          }))
                        : record(current, option)
                    }
                  >
                    {many && (
                      <span className="qa-tick" aria-hidden="true">
                        {on ? "✓" : ""}
                      </span>
                    )}
                    {option}
                    {tip && <span className="qa-tip">Suggested</span>}
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
            {/* A set is sent by this button and not by the ticks, so it stays
                pressable on ticks alone — with nothing typed there would
                otherwise be no way to send what you picked. */}
            <button className="ask-btn" type="submit" disabled={sending || !pending}>
              {page + 1 === total && summaryPage < 0 ? "Answer" : "Next"}
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
