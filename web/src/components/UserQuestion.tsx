// The agent asking you something.
//
// Print mode is never offered `AskUserQuestion`, so this arrives through a tool
// of our own (scripts/mcp/octiq-ask.cjs). The agent is blocked on it: it asked
// because the decision is yours, and it will not guess while it waits.
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

export function UserQuestion({
  question,
  position,
  onAnswered,
}: {
  question: Question;
  /** Set only when more than one is waiting, so a single question is not
   *  labelled "1 of 1". */
  position?: { index: number; total: number };
  onAnswered: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const options = question.options ?? [];

  /* Closing is an answer, not a disappearance.
   *
   * The agent is blocked on this call — dismissing the card without replying
   * would leave it waiting out the full ten-minute timeout, having been told
   * nothing. So the × sends this instead: it unblocks the agent at once and
   * says plainly what happened, in the same voice as the timeout message, so it
   * does not invent a preference you never expressed. */
  const DECLINED =
    "The user closed this question without answering. Do not assume an answer — " +
    "say what you need and stop, or continue in a way that does not depend on it.";

  const answer = async (value: string) => {
    const said = value.trim();
    if (!said || sending) return;
    setSending(true);
    try {
      await bridge.invoke("question_answer", { id: question.id, answer: said });
    } catch {
      // Expired while the tap was in flight; either way it is answered or gone.
    }
    onAnswered(question.id);
  };

  return (
    <div className="qa-card" role="alertdialog" aria-label="The agent has a question">
      <div className="qa-head">
        <span className="qa-dot" aria-hidden="true" />
        <span className="qa-label">Claude is asking</span>
        {position && (
          <span className="qa-count">
            {position.index} of {position.total}
          </span>
        )}
        <button
          className="qa-close"
          type="button"
          disabled={sending}
          title="Close without answering"
          aria-label="Close without answering"
          onClick={() => void answer(DECLINED)}
        >
          ×
        </button>
      </div>

      <p className="qa-question">{question.question}</p>

      {options.length > 0 ? (
        <div className="qa-options">
          {options.map((option) => (
            <button
              key={option}
              className="qa-option"
              type="button"
              disabled={sending}
              onClick={() => void answer(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="qa-free"
          onSubmit={(e) => {
            e.preventDefault();
            void answer(text);
          }}
        >
          <input
            className="qa-input"
            value={text}
            autoFocus
            placeholder="Your answer…"
            disabled={sending}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="ask-btn is-primary" type="submit" disabled={sending || !text.trim()}>
            {sending ? "Sending…" : "Answer"}
          </button>
        </form>
      )}

      {/* Always available, even with options: "neither" is a real answer, and
          a question you can only answer one of two ways is a trap. */}
      {options.length > 0 && (
        <form
          className="qa-free"
          onSubmit={(e) => {
            e.preventDefault();
            void answer(text);
          }}
        >
          <input
            className="qa-input"
            value={text}
            placeholder="…or say something else"
            disabled={sending}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="ask-btn" type="submit" disabled={sending || !text.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}
