// Card 79 — reading a question and its answer off an `ask_user` call.
import { describe, expect, it } from "vitest";

import { askAnswer } from "./askAnswer";

const ASK = "mcp__octiq__ask_user";
const args = { question: "Ship it now, or wait for the review?" };

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

    expect(read?.question).toBe("Ship it now, or wait for the review?");
    expect(read?.answer).toBe("");
    expect(read?.unanswered).toBeUndefined();
  });

  it("carries what they said, once they have said it", () => {
    expect(askAnswer(ASK, args, "wait for the review")?.answer).toBe("wait for the review");
  });

  it("does not read a machine's excuse as something the person chose", () => {
    // These four are the ONLY things that come back without a person having
    // typed them. Shown as an answer, each one puts words in their mouth —
    // and "The question timed out" reads as a decision to time out.
    for (const excuse of [
      "The user closed this question without answering. Do not assume an answer.",
      "The user did not answer in time. Do not assume an answer.",
      "OctiqFlow is not reachable, so the user could not be asked.",
      "The question timed out.",
    ]) {
      const read = askAnswer(ASK, args, excuse);
      expect(read?.answer, excuse).toBe("");
      expect(read?.unanswered, excuse).toBeTruthy();
    }
  });

  it("says which excuse it was, in words a reader can act on", () => {
    expect(askAnswer(ASK, args, "The user closed this question without answering. Do not assume an answer.")?.unanswered)
      .toBe("closed without answering");
    expect(askAnswer(ASK, args, "The user did not answer in time. Do not assume an answer.")?.unanswered)
      .toBe("not answered in time");
    expect(askAnswer(ASK, args, "The question timed out.")?.unanswered).toBe("not answered in time");
    expect(askAnswer(ASK, args, "OctiqFlow could not be reached.")?.unanswered).toBe("could not be asked");
  });

  it("keeps an answer that merely mentions one of those phrases", () => {
    // The excuses are recognised by how they OPEN, not by appearing anywhere.
    // Someone answering "the question timed out last time, so try again" has
    // told the agent something, and it is not an excuse.
    const said = "the question timed out last time, so try again";

    expect(askAnswer(ASK, args, said)?.answer).toBe(said);
    expect(askAnswer(ASK, args, said)?.unanswered).toBeUndefined();
  });
});
