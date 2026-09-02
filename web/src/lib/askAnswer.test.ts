// Card 79 — reading a question and its answer off an `ask_user` call.
import { describe, expect, it } from "vitest";

import { askAnswer } from "./askAnswer";

const ASK = "mcp__octiq__ask_user";
const QUESTION = "Ship it now, or wait for the review?";
const args = { question: QUESTION };

describe("what an ask_user call decided", () => {
  it("is nothing at all for any other tool", () => {
    // Every card in the app runs through this. A reader that claims other
    // calls would put a question on a Bash row.
    expect(askAnswer("Bash", { question: "?" }, "ok")).toBeNull();
    expect(askAnswer("mcp__octiq__pin_file", args, "ok")).toBeNull();
  });

  it("is nothing until the question itself has arrived", () => {
    // Arguments stream in as JSON fragments, so the first render of a card
    // often has none of them. A card drawn from that says "asked: " and
    // nothing after it.
    expect(askAnswer(ASK, {}, undefined)).toBeNull();
    expect(askAnswer(ASK, { question: "   " }, undefined)).toBeNull();
  });

  it("carries the question while the person is still deciding", () => {
    const read = askAnswer(ASK, args, undefined);

    expect(read).toEqual([{ question: QUESTION, answer: "" }]);
  });

  it("carries what they said, once they have said it", () => {
    expect(askAnswer(ASK, args, "wait for the review")).toEqual([
      { question: QUESTION, answer: "wait for the review" },
    ]);
  });

  it("does not read a machine's excuse as something the person chose", () => {
    // These are the ONLY things that come back without a person having typed
    // them. Shown as an answer, each one puts words in their mouth — and "The
    // question timed out" reads as a decision to time out.
    for (const excuse of [
      "The user closed this question without answering. Do not assume an answer.",
      "The user did not answer in time. Do not assume an answer.",
      "OctiqFlow is not reachable, so the user could not be asked.",
      "The question timed out.",
      "Nobody is watching OctiqFlow, so this question could not be asked. Proceed without it, or say what you would need to know.",
    ]) {
      const [read] = askAnswer(ASK, args, excuse)!;
      expect(read.answer, excuse).toBe("");
      expect(read.unanswered, excuse).toBeTruthy();
    }
  });

  it("says which excuse it was, in words a reader can act on", () => {
    expect(
      askAnswer(ASK, args, "The user closed this question without answering. Do not assume an answer.")![0]
        .unanswered,
    ).toBe("closed without answering");
    expect(
      askAnswer(ASK, args, "The user did not answer in time. Do not assume an answer.")![0].unanswered,
    ).toBe("not answered in time");
    expect(askAnswer(ASK, args, "The question timed out.")![0].unanswered).toBe("not answered in time");
    expect(askAnswer(ASK, args, "OctiqFlow could not be reached.")![0].unanswered).toBe(
      "could not be asked",
    );
    expect(
      askAnswer(
        ASK,
        args,
        "Nobody is watching OctiqFlow any more, so this question went unanswered. Proceed without it, or say what you would need to know.",
      )![0].unanswered,
    ).toBe("nobody was there to ask");
  });

  it("keeps an answer that merely mentions one of those phrases", () => {
    // The excuses are recognised by how they OPEN, not by appearing anywhere.
    // Someone answering "the question timed out last time, so try again" has
    // told the agent something, and it is not an excuse.
    const said = "the question timed out last time, so try again";

    expect(askAnswer(ASK, args, said)).toEqual([{ question: QUESTION, answer: said }]);
  });

  it("still reads the legacy single-question shape", () => {
    // No `questions` array at all — the shape every call used before a batch
    // was possible, and still what a one-question call sends.
    expect(askAnswer(ASK, { question: QUESTION, options: ["a", "b"] }, "a")).toEqual([
      { question: QUESTION, answer: "a" },
    ]);
  });

  it("reads a single question sent as a one-item batch the same way", () => {
    // `questions: [ { question } ]` is still one question. Its result has no
    // `Q1:`/`A1:` framing — the server does not bother writing that for one —
    // so it is read exactly like the legacy shape: the whole result, unparsed.
    const read = askAnswer(ASK, { questions: [{ question: QUESTION }] }, "wait for the review");

    expect(read).toEqual([{ question: QUESTION, answer: "wait for the review" }]);
  });
});

describe("a batch of several questions on one call", () => {
  const Q1 = "Ship it now, or wait for the review?";
  const Q2 = "Which environment?";
  const batchArgs = { questions: [{ question: Q1 }, { question: Q2 }] };

  it("is every question, empty, while the call is still streaming its arguments", () => {
    expect(askAnswer(ASK, batchArgs, undefined)).toEqual([
      { question: Q1, answer: "" },
      { question: Q2, answer: "" },
    ]);
  });

  it("maps each answer to its own question once the batch is answered", () => {
    const said = [
      `Q1: ${Q1}`,
      "A1: Ship it now",
      "",
      `Q2: ${Q2}`,
      "A2: staging",
    ].join("\n");

    expect(askAnswer(ASK, batchArgs, said)).toEqual([
      { question: Q1, answer: "Ship it now" },
      { question: Q2, answer: "staging" },
    ]);
  });

  it("marks only the question whose own answer was an excuse", () => {
    // The first question got a real answer; only the second timed out. A
    // reader has to be able to tell those apart within the same call.
    const said = [
      `Q1: ${Q1}`,
      "A1: Ship it now",
      "",
      `Q2: ${Q2}`,
      "A2: The user did not answer in time. Do not assume an answer — " +
        "say what you need and stop, or continue in a way that does not depend on it.",
    ].join("\n");

    const [first, second] = askAnswer(ASK, batchArgs, said)!;

    expect(first).toEqual({ question: Q1, answer: "Ship it now" });
    expect(second.answer).toBe("");
    expect(second.unanswered).toBe("not answered in time");
  });

  it("marks the whole batch unanswered when nobody was there to ask at all", () => {
    // No `Q1:`/`A1:` framing here — the call never got far enough to write
    // any. Every question in the batch shares the one excuse.
    const said =
      "Nobody is watching OctiqFlow, so this question could not be asked. " +
      "Proceed without it, or say what you would need to know.";

    expect(askAnswer(ASK, batchArgs, said)).toEqual([
      { question: Q1, answer: "", unanswered: "nobody was there to ask" },
      { question: Q2, answer: "", unanswered: "nobody was there to ask" },
    ]);
  });
});
