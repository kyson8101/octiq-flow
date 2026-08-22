import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The card answers the question over the socket, and the bridge opens that
// socket off `location.href` the moment its module loads — there is no
// `location` in the node test environment. Nothing here answers anything.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => undefined } }));

import { UserQuestion, type Question } from "./UserQuestion";

const question = (over: Partial<Question> = {}): Question => ({
  id: "q1",
  question: "Which parts should I rebuild?",
  options: ["Rust", "Web"],
  ...over,
});

const draw = (q: Question) =>
  renderToStaticMarkup(<UserQuestion questions={[q]} onDone={() => {}} />);

describe("UserQuestion", () => {
  it("draws ticks, not a single choice, when the answer is a set", () => {
    // Buttons that answer the moment you press them cannot express "these two".
    // The role is what says so before the first tap, to a screen reader as much
    // as to a pointer.
    const out = draw(question({ multiple: true }));
    expect(out.match(/role="checkbox"/g)).toHaveLength(2);
    expect(out.match(/aria-checked="false"/g)).toHaveLength(2);
    expect(out).toContain("Pick as many as you like");
  });

  it("leaves an either/or question as it was", () => {
    // Only the agent knows which of its questions takes a set. Without the flag
    // the card must not invite two answers to a question that has one.
    const out = draw(question());
    expect(out).not.toContain("role=\"checkbox\"");
    expect(out).not.toContain("Pick as many as you like");
  });

  it("can be put aside so the conversation underneath can be read", () => {
    // The agent is blocked, so the card cannot simply be closed to go and look
    // at what led to the question — closing it is an answer. Minimising is the
    // way back to the transcript that does not decide anything.
    const out = draw(question());
    expect(out).toContain("Hide while you read");
  });
});
