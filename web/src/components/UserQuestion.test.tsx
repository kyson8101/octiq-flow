// The question card, drawn from the two shapes a question arrives in.
//
// Both are worth a test for the same reason: neither failure announced itself.
// Options sent as `{label, description}` objects — the shape every Claude model
// is trained on — used to be stringified into four buttons reading
// `[object Object]`, and a set-shaped question sent as `multiSelect` used to
// draw as a one-of card with no ticks at all.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The bridge reads `location` as it loads, and these tests run in node with no
// document. Nothing here answers a question, so a stub that never resolves is
// the whole of what the card needs from it.
vi.mock("../lib/bridge", () => ({
  bridge: { invoke: async () => undefined, on: () => () => {} },
}));

import { UserQuestion } from "./UserQuestion";
import type { Question } from "./UserQuestion";

const ask = (over: Partial<Question> = {}) =>
  ({ id: "q1", question: "Which database?", ...over }) as Question;

/** The card opened out. The app never draws it this way on arrival — see the
 *  arrival tests below — and these run in node with no document, so the strip
 *  cannot be pressed to get here. */
const draw = (over: Partial<Question> = {}) =>
  renderToStaticMarkup(<UserQuestion questions={[ask(over)]} onDone={() => {}} startOpen />);

/** The card exactly as a question arrives: nothing passed but the question. */
const arrive = (over: Partial<Question> = {}) =>
  renderToStaticMarkup(<UserQuestion questions={[ask(over)]} onDone={() => {}} />);

describe("UserQuestion", () => {
  it("puts a labelled choice on the button and its description under it", () => {
    const html = draw({
      options: [{ label: "SQLite", description: "One file, no server" }],
    });
    expect(html).toContain("SQLite");
    expect(html).toContain("One file, no server");
    // The thing that used to be on the button instead of either of them.
    expect(html).not.toContain("[object Object]");
  });

  it("still draws a plain list of strings", () => {
    // An older server sends this shape, and the client deploys ahead of it.
    const html = draw({ options: ["Postgres", "SQLite"] });
    expect(html).toContain("Postgres");
    expect(html).toContain("SQLite");
  });

  it("draws a set as ticks, and says so before the first tap", () => {
    const html = draw({ options: ["a", "b"], multiple: true });
    expect(html).toContain('role="checkbox"');
    expect(html).toContain("Pick as many as you like");
  });

  it("draws a one-of question with no ticks at all", () => {
    const html = draw({ options: ["a", "b"] });
    expect(html).not.toContain('role="checkbox"');
  });

  it("marks the agent's suggestion in words, not in colour alone", () => {
    const html = draw({ options: ["a", "b"], recommended: 1 });
    expect(html).toContain("Suggested");
  });
});

describe("a tap is a choice, not an answer", () => {
  it("offers a one-of question as radios, so pressing one decides nothing yet", () => {
    // A single tap used to SEND. One mis-tap on a phone was an answer the agent
    // acted on, with no way to take it back.
    const html = draw({ options: ["a", "b"] });
    expect(html).toContain('role="radio"');
    expect(html).toContain('role="radiogroup"');
  });

  it("says how to send it, in the words on the button", () => {
    const html = draw({ options: ["a", "b"] });
    expect(html).toContain("Pick one, then press Answer");
  });

  it("keeps the send button dead until something is picked", () => {
    const html = draw({ options: ["a", "b"] });
    expect(html).toMatch(/<button[^>]*class="ask-btn"[^>]*disabled/);
  });
});

describe("a question arrives put aside", () => {
  it("comes as the strip, not the question opened out", () => {
    // It used to arrive open, above the composer, and the conversation holding
    // the answer went off screen at the moment it was needed.
    const html = arrive({ options: ["Postgres", "SQLite"] });
    expect(html).toContain("qa-card is-min");
    expect(html).toContain("qa-restore");
    expect(html).not.toContain('role="alertdialog"');
  });

  it("draws none of the controls, so there is nothing to mis-tap", () => {
    const html = arrive({ options: ["Postgres", "SQLite"] });
    expect(html).not.toContain("qa-options");
    expect(html).not.toContain("qa-input");
    expect(html).not.toContain("ask-btn");
  });

  it("still says what is waiting", () => {
    // The whole point of a strip over nothing at all: one line of the question,
    // the pulsing dot, and the word that says pressing it answers.
    const html = arrive();
    expect(html).toContain("Which database?");
    expect(html).toContain("qa-dot");
    expect(html).toContain("Answer");
  });

  it("uses a title and subtitle for the waiting question", () => {
    const html = arrive();

    expect(html).toContain('class="qa-min-copy"');
    expect(html).toContain('class="qa-min-title">Claude is asking</span>');
    expect(html).toContain('class="qa-min-q">Which database?</span>');
  });

  it("opens on request, controls and all", () => {
    const html = draw({ options: ["Postgres", "SQLite"] });
    expect(html).toContain('role="alertdialog"');
    expect(html).not.toContain("is-min");
  });
});
