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
// single control would serve one of them badly.
import { useState } from "react";
import { bridge } from "../lib/bridge";

export type Question = {
  id: string;
  chatKey?: string;
  question: string;
  options?: string[];
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
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const total = questions.length;
  // One page per question, plus a summary — but a single question needs no
  // summary of itself, so it submits from its own page.
  const summaryPage = total > 1 ? total : -1;
  const onSummary = page === summaryPage;
  const current = onSummary ? undefined : questions[page];
  const answered = questions.filter((q) => answers[q.id]).length;

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

          {(current.options ?? []).length > 0 && (
            <div className="qa-options">
              {(current.options ?? []).map((option) => (
                <button
                  key={option}
                  className={`qa-option ${answers[current.id] === option ? "is-on" : ""}`}
                  type="button"
                  disabled={sending}
                  onClick={() => record(current, option)}
                >
                  {option}
                </button>
              ))}
            </div>
          )}

          {/* Always available, even with options: "neither" is a real answer,
              and a question you can only answer one of two ways is a trap. */}
          <form
            className="qa-free"
            onSubmit={(e) => {
              e.preventDefault();
              record(current, text);
            }}
          >
            <input
              className="qa-input"
              value={text}
              autoFocus={(current.options ?? []).length === 0}
              placeholder={
                (current.options ?? []).length > 0 ? "…or say something else" : "Your answer…"
              }
              disabled={sending}
              onChange={(e) => setText(e.target.value)}
            />
            <button className="ask-btn" type="submit" disabled={sending || !text.trim()}>
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
