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

const draw = (over: Partial<Question> = {}) =>
  renderToStaticMarkup(
    <UserQuestion
      questions={[
        {
          id: "q1",
          question: "Which database?",
          ...over,
        } as Question,
      ]}
      onDone={() => {}}
    />,
  );

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
