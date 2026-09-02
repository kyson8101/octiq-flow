// Card 79 — the card of an `ask_user` call carries the decision it made.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Tool } from "../lib/toolGroups";
import { ToolCard } from "./ToolCard";

const QUESTION = "Ship it now, or wait for the review?";

const ask = (over: Partial<Tool> = {}): Tool =>
  ({
    kind: "tool",
    id: "t1",
    name: "mcp__octiq__ask_user",
    argsJson: "{}",
    args: { question: QUESTION, options: ["Ship now", "Wait"] },
    state: "done",
    ...over,
  }) as Tool;

describe("an answered question, on the call that asked it", () => {
  it("shows the question without being opened", () => {
    // The live card is gone by now. Folded shut, the row said `ask_user` and
    // nothing else — neither what was asked nor what was decided.
    const html = renderToStaticMarkup(<ToolCard tool={ask({ result: "Wait" })} />);

    expect(html).toContain(QUESTION);
  });

  it("shows the answer without being opened", () => {
    const html = renderToStaticMarkup(<ToolCard tool={ask({ result: "Wait" })} />);

    expect(html).toContain("Wait");
  });

  it("does not print the machine's excuse as something you chose", () => {
    const html = renderToStaticMarkup(
      <ToolCard tool={ask({ result: "The question timed out." })} />,
    );

    expect(html).toContain("not answered in time");
    expect(html).not.toContain("The question timed out.");
  });

  it("shows the question whole, not cut off at the width of a row", () => {
    // `tool-detail` ellipsises from the LEFT so a long path keeps its useful
    // end. A question's useful end is its start, and half a question is not a
    // question — so it gets a line of its own rather than a share of the row.
    const html = renderToStaticMarkup(<ToolCard tool={ask({ result: "Wait" })} />);

    expect(html).toContain(QUESTION);
    expect(html).not.toContain("tool-detail");
  });

  it("shows the question while the person is still deciding", () => {
    // The live card is on screen at this moment, so this is the second copy —
    // but the live card can be put aside, and then this is the only one.
    const html = renderToStaticMarkup(<ToolCard tool={ask({ state: "running" })} />);

    expect(html).toContain(QUESTION);
    expect(html).not.toContain("tool-answer-said");
    expect(html).not.toContain("tool-answer-none");
  });

  it("does not say the answer twice when the card is opened", () => {
    // The generic `result` block would repeat it verbatim under a label that
    // calls a person's decision the tool's output.
    const html = renderToStaticMarkup(<ToolCard tool={ask({ result: "Wait" })} open />);

    expect(html).not.toContain(">result<");
  });

  it("still opens onto the options it offered", () => {
    // The arguments are worth keeping: which choices were on the table is half
    // of what an answer means.
    const html = renderToStaticMarkup(<ToolCard tool={ask({ result: "Wait" })} open />);

    expect(html).toContain("Ship now");
  });

  it("leaves every other call exactly as it was", () => {
    const bash = {
      kind: "tool",
      id: "t2",
      name: "Bash",
      argsJson: "{}",
      args: { command: "cargo test", question: "not a question" },
      result: "ok",
      state: "done",
    } as Tool;

    expect(renderToStaticMarkup(<ToolCard tool={bash} open />)).not.toContain("tool-answer");
  });
});

describe("a batch of several questions, on the one call that asked them all", () => {
  const Q1 = "Ship it now, or wait for the review?";
  const Q2 = "Which environment?";
  const Q3 = "Anything else before we go?";

  const batch = (result: string): Tool =>
    ({
      kind: "tool",
      id: "t3",
      name: "mcp__octiq__ask_user",
      argsJson: "{}",
      args: { questions: [{ question: Q1 }, { question: Q2 }, { question: Q3 }] },
      result,
      state: "done",
    }) as Tool;

  it("shows all three questions and all three answers without being opened", () => {
    const said = [
      `Q1: ${Q1}`,
      "A1: Ship it now",
      "",
      `Q2: ${Q2}`,
      "A2: staging",
      "",
      `Q3: ${Q3}`,
      "A3: No, that's everything",
    ].join("\n");

    const html = renderToStaticMarkup(<ToolCard tool={batch(said)} />);

    expect(html).toContain(Q1);
    expect(html).toContain(Q2);
    expect(html).toContain(Q3);
    expect(html).toContain("Ship it now");
    expect(html).toContain("staging");
    expect(html).toContain("No, that&#x27;s everything");
  });

  it("shows the app's words for an excuse on one answer, never the machine sentence", () => {
    const said = [
      `Q1: ${Q1}`,
      "A1: Ship it now",
      "",
      `Q2: ${Q2}`,
      "A2: The user did not answer in time. Do not assume an answer — " +
        "say what you need and stop, or continue in a way that does not depend on it.",
      "",
      `Q3: ${Q3}`,
      "A3: No, that's everything",
    ].join("\n");

    const html = renderToStaticMarkup(<ToolCard tool={batch(said)} />);

    expect(html).toContain("not answered in time");
    expect(html).not.toContain("The user did not answer in time");
    // The other two answers are real and must not be swallowed by the excuse.
    expect(html).toContain("Ship it now");
    expect(html).toContain("No, that&#x27;s everything");
  });
});
