// The answered line, as the host writes it.
//
// When the answer to a question is handed to the agent while its call
// waits, the host writes one `octiq_question_answered` event into the chat's
// record (docs/question-delivery.md, The answered line). These are the two
// lines the host's own tests wrote (`__fixtures__/host`, never hand-edited),
// read as the type the page has for them, and reduced into the transcript
// item the page draws the answered question from.
import { describe, expect, it } from "vitest";

import { emptyChat, reduceChat } from "./chat";
import { hostFacts } from "./__fixtures__/hostFacts";
import { answeredMessageId, QUESTION_ANSWERED, type QuestionAnswered } from "./question";
import { ANSWER_TURN_PREFIX, isAnswerTurn } from "./questionBlock";

const both = (): [string, QuestionAnswered][] => [
  ["native", hostFacts.questionAnsweredNative()],
  ["tool", hostFacts.questionAnsweredTool()],
];

describe("octiq_question_answered, as the host serialises it", () => {
  it("names its record, how the answer went and when", () => {
    for (const [via, line] of both()) {
      expect(line.type).toBe(QUESTION_ANSWERED);
      expect(line.via).toBe(via);
      expect(line.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(line.at).toBeGreaterThan(0);
      // The same record's late answer would be this turn: one id for both.
      expect(isAnswerTurn(`${ANSWER_TURN_PREFIX}${line.id}`)).toBe(true);
    }
  });

  it("keeps every question as asked, with its answer", () => {
    const native = hostFacts.questionAnsweredNative();
    expect(native.questions.map((q) => [q.question, q.answer])).toEqual([
      ["Which branch should this go to?", "develop"],
      ["What should the tag be called?", "v0.3.11"],
    ]);
    expect(native.questions[0].options).toEqual([
      { label: "develop", description: "The base for new work" },
      { label: "main" },
    ]);
    // A free-text question has no options, as a list and not as nothing.
    expect(native.questions[1].options).toEqual([]);
    // Codex's own request recommends nothing: the key is absent, not null.
    for (const q of native.questions) {
      expect("recommended" in q).toBe(false);
      expect(q.multiple).toBe(false);
    }

    const tool = hostFacts.questionAnsweredTool();
    expect(tool.questions[0].recommended).toBe(1);
    expect(tool.questions[0].options[1]).toEqual({ label: "SQLite", description: "One file, no server" });
    expect(tool.questions[0].answer).toBe("SQLite");
    expect(tool.questions[1].multiple).toBe(true);
    expect(tool.questions[1].answer).toBe("cargo test, pnpm test");
    for (const [, line] of both()) {
      for (const q of line.questions) {
        expect(typeof q.id).toBe("string");
        expect(q.options.every((option) => typeof option.label === "string")).toBe(true);
      }
    }
  });

  it("is one item of the transcript, which the page draws the answered question from", () => {
    // What is drawn from it is `components/InlineQuestions.answered.test.tsx`.
    for (const [, line] of both()) {
      const after = reduceChat(emptyChat(), line);
      expect(after.messages).toEqual([{ id: answeredMessageId(line.id), role: "assistant", streaming: false, blocks: [{ kind: "answered", answered: line }] }]);
      // Heard again (a write that failed is tried and said again): one item.
      expect(reduceChat(after, line)).toBe(after);
    }
  });
});
