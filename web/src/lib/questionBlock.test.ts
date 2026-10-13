// The agent's questions, as the transcript draws them: where a batch goes,
// what is selected when it arrives, what the button would send, and what the
// answer bubble says.
import { describe, expect, it } from "vitest";

import type { Block, Message } from "./chat";
import type { Question } from "./question";
import {
  answerTurn, answerTurnOf, answeredNote, asks, batchesOf, isAnswerTurn, lateAnswerTo, lateAnswers,
  pickAnswer, placeQuestions, saidLines, saidText, startPick, submitReason, waitingLabel,
} from "./questionBlock";
import { askAnswer } from "./askAnswer";

const ASK = "mcp__octiq__ask_user";

const call = (id: string, questions: string[], result?: string): Block => ({
  kind: "tool", id, name: ASK, argsJson: "{}",
  args: questions.length === 1 ? { question: questions[0] } : { questions: questions.map((question) => ({ question })) },
  result, state: result === undefined ? "running" : "done",
}) as Block;

const said = (id: string, blocks: Block[], over: Partial<Message> = {}): Message =>
  ({ id, role: "assistant", blocks, streaming: false, ...over });

const q = (id: string, question: string, over: Partial<Question> = {}): Question =>
  ({ id, chatKey: "chat:c1", question, ...over });

/** The host's turn for answers that arrived after their call had ended
 *  (`question_store::Record::continuation`), word for word. */
const continuation = (pairs: [string, string][], id = "r1") =>
  `The user answered your saved OctiqFlow questions (request ${id}).\n\n` +
  pairs.map(([question, answer], i) => `Q${i + 1}: ${question}\nA${i + 1}: ${answer}`).join("\n\n") +
  "\n\nContinue the original task using these answers and the conversation context. Check what is already complete before acting; do not repeat completed actions. These answers apply to the questions above, not to unrelated later requests.";

const NOT_IN_TIME = "The questions are saved and still waiting for the user. End this turn without assuming an answer or repeating the questions. OctiqFlow will continue this conversation when the answers arrive.";

describe("the calls a chat's questions came from", () => {
  it("is one batch per call, in the order they were asked", () => {
    const batches = batchesOf([
      q("a", "One?", { batch: "b1" }), q("x", "Alone?"), q("b", "Two?", { batch: "b1" }),
    ]);
    expect(batches.map((batch) => [batch.key, batch.questions.map((item) => item.id)])).toEqual([
      ["b1", ["a", "b"]], ["x", ["x"]],
    ]);
  });

  it("still asks until every question has an answer", () => {
    const [open] = batchesOf([q("a", "One?", { batch: "b", answer: "Yes", status: "saved" }), q("b", "Two?", { batch: "b", status: "pending" })]);
    expect(asks(open)).toBe(true);
    const [done] = batchesOf([q("a", "One?", { answer: "Yes", status: "saved" })]);
    expect(asks(done)).toBe(false);
    // A host older than the durable store lists only unanswered questions.
    expect(asks(batchesOf([q("a", "One?")])[0])).toBe(true);
  });
});

describe("where a pending batch is drawn", () => {
  it("is at the call that asked it", () => {
    const messages = [said("m1", [{ kind: "text", text: "One thing first." }, call("t1", ["Which database?"])])];
    const placed = placeQuestions(messages, [q("a", "Which database?")]);
    expect(placed.byTool.get("t1")?.questions.map((item) => item.id)).toEqual(["a"]);
    expect(placed.loose).toEqual([]);
  });

  it("matches a batch by all of its questions, in order", () => {
    const messages = [said("m1", [call("t1", ["One?", "Two?"]), call("t2", ["Two?", "One?"])])];
    const placed = placeQuestions(messages, [q("a", "One?", { batch: "b" }), q("b", "Two?", { batch: "b" })]);
    expect([...placed.byTool.keys()]).toEqual(["t1"]);
  });

  it("is at the end when the page holds no call for it", () => {
    // Asked after a reload, in an older record, or by a provider with no
    // such call in its stream.
    const placed = placeQuestions([said("m1", [{ kind: "text", text: "Hello" }])], [q("a", "Which database?")]);
    expect(placed.byTool.size).toBe(0);
    expect(placed.loose.map((batch) => batch.key)).toEqual(["a"]);
  });

  it("never lands on a call that was already answered", () => {
    // The same words asked twice: the first was answered, the second waits.
    const messages = [said("m1", [call("t1", ["Ship it?"], "Yes")]), said("m2", [call("t2", ["Ship it?"])])];
    expect([...placeQuestions(messages, [q("a", "Ship it?")]).byTool.keys()]).toEqual(["t2"]);
    // And with only the answered call in view, the pending one goes to the end.
    expect(placeQuestions(messages.slice(0, 1), [q("a", "Ship it?")]).loose).toHaveLength(1);
  });

  it("stays at a call that ended with its questions still waiting", () => {
    const messages = [said("m1", [call("t1", ["Ship it?"], NOT_IN_TIME)])];
    expect([...placeQuestions(messages, [q("a", "Ship it?")]).byTool.keys()]).toEqual(["t1"]);
  });

  it("gives the newest calls to the newest batches when the words repeat", () => {
    const messages = [said("m1", [call("t1", ["Again?"])]), said("m2", [call("t2", ["Again?"])])];
    const two = placeQuestions(messages, [q("old", "Again?"), q("new", "Again?")]);
    expect(two.byTool.get("t1")?.key).toBe("old");
    expect(two.byTool.get("t2")?.key).toBe("new");
    // One call in view, two batches: the older batch is the one without it.
    const one = placeQuestions(messages.slice(1), [q("old", "Again?"), q("new", "Again?")]);
    expect(one.byTool.get("t2")?.key).toBe("new");
    expect(one.loose.map((batch) => batch.key)).toEqual(["old"]);
  });

  it("leaves a subagent's call to its own card", () => {
    const messages = [said("m1", [call("t1", ["From a subagent?"])], { parent: "task-1" })];
    const placed = placeQuestions(messages, [q("a", "From a subagent?")]);
    expect(placed.byTool.size).toBe(0);
    expect(placed.loose).toHaveLength(1);
  });

  it("costs nothing when nothing is asked", () => {
    const a = placeQuestions([said("m1", [call("t1", ["One?"])])], []);
    expect(a.byTool.size).toBe(0);
    expect(placeQuestions([], [])).toBe(a);
  });
});

describe("what is selected when the block arrives", () => {
  const options = [{ label: "Postgres" }, { label: "SQLite", description: "One file" }];

  it("is the recommended option, and nothing without one", () => {
    expect(startPick(q("a", "Which?", { options, recommended: 1 }))).toEqual({ chosen: "SQLite", ticks: [], other: false, text: "" });
    expect(startPick(q("a", "Which?", { options })).chosen).toBeUndefined();
    // A stray index marks nothing.
    expect(startPick(q("a", "Which?", { options, recommended: 9 })).chosen).toBeUndefined();
  });

  it("ticks the recommended option of a set", () => {
    expect(startPick(q("a", "Which?", { options, recommended: 0, multiple: true })).ticks).toEqual(["Postgres"]);
    expect(startPick(q("a", "Which?", { options, multiple: true })).ticks).toEqual([]);
  });

  it("is nothing typed for a question with no options", () => {
    expect(startPick(q("a", "What is it called?"))).toEqual({ chosen: undefined, ticks: [], other: false, text: "" });
  });
});

describe("what the button would send", () => {
  const options = ["Postgres", "SQLite"];
  const one = q("a", "Which?", { options });
  const many = q("a", "Which?", { options, multiple: true });

  it("is the selected option", () => {
    expect(pickAnswer(one, { chosen: "SQLite", ticks: [], other: false, text: "" })).toBe("SQLite");
    expect(pickAnswer(one, { ticks: [], other: false, text: "" })).toBe("");
    // An option no longer on offer is not an answer.
    expect(pickAnswer(one, { chosen: "MySQL", ticks: [], other: false, text: "" })).toBe("");
  });

  it("is what is typed once Other is chosen, and nothing while it is empty", () => {
    expect(pickAnswer(one, { chosen: "SQLite", ticks: [], other: true, text: "  DuckDB " })).toBe("DuckDB");
    expect(pickAnswer(one, { chosen: "SQLite", ticks: [], other: true, text: "   " })).toBe("");
    // Typed text is not sent while Other is not the one chosen.
    expect(pickAnswer(one, { chosen: "SQLite", ticks: [], other: false, text: "DuckDB" })).toBe("SQLite");
  });

  it("is every tick of a set in the order offered, with Other's words last", () => {
    expect(pickAnswer(many, { ticks: ["SQLite", "Postgres"], other: false, text: "" })).toBe("Postgres, SQLite");
    expect(pickAnswer(many, { ticks: ["SQLite"], other: true, text: "and DuckDB" })).toBe("SQLite, and DuckDB");
    expect(pickAnswer(many, { ticks: ["SQLite"], other: false, text: "and DuckDB" })).toBe("SQLite");
    expect(pickAnswer(many, { ticks: [], other: true, text: "" })).toBe("");
  });

  it("is what is typed for a question with no options", () => {
    expect(pickAnswer(q("a", "Name?"), { ticks: [], other: false, text: " octiq " })).toBe("octiq");
  });

  it("is sent as the recommended option when nothing was touched", () => {
    const tip = q("a", "Which?", { options, recommended: 0 });
    expect(pickAnswer(tip, startPick(tip))).toBe("Postgres");
  });
});

describe("why the button is off", () => {
  const options = ["Yes", "No"];

  it("is nothing once every question has an answer", () => {
    expect(submitReason([q("a", "Ship?", { options, recommended: 0 })], {})).toBeNull();
    expect(submitReason([q("a", "Ship?", { options })], { a: { chosen: "No", ticks: [], other: false, text: "" } })).toBeNull();
  });

  it("says what one question still needs", () => {
    expect(submitReason([q("a", "Ship?", { options })], {})).toBe("Choose an answer to send it.");
    expect(submitReason([q("a", "Name?")], {})).toBe("Type your answer to send it.");
    expect(submitReason([q("a", "Ship?", { options })], { a: { ticks: [], other: true, text: "" } })).toBe("Type your answer to send it.");
  });

  it("counts what several still need", () => {
    const batch = [q("a", "One?", { options, recommended: 0 }), q("b", "Two?", { options }), q("c", "Three?")];
    expect(submitReason(batch, {})).toBe("2 of 3 questions still need an answer.");
    expect(submitReason(batch, { b: { chosen: "No", ticks: [], other: false, text: "" } })).toBe("1 of 3 questions still needs an answer.");
    expect(submitReason(batch.slice(1), {})).toBe("Answer all 2 questions to send them.");
  });
});

describe("what the answer bubble says", () => {
  it("is the bare answer for one question", () => {
    const lines = saidLines([{ question: "Which database?", answer: "SQLite" }]);
    expect(lines).toEqual([{ answer: "SQLite" }]);
    expect(saidText(lines[0])).toBe("SQLite");
  });

  it("is each question and its answer for several", () => {
    const lines = saidLines([{ question: "Which database?", answer: "SQLite" }, { question: "Name", answer: "octiq" }]);
    expect(lines.map(saidText)).toEqual(["Which database? SQLite", "Name: octiq"]);
  });

  it("says a question of several went unanswered, in words", () => {
    const lines = saidLines([{ question: "One?", answer: "Yes" }, { question: "Two?", answer: "", unanswered: "closed without answering" }]);
    expect(lines[1]).toEqual({ label: "Two?", answer: "closed without answering", none: true });
  });

  it("is nothing at all when nothing was said", () => {
    expect(saidLines([{ question: "One?", answer: "", unanswered: "closed without answering" }])).toEqual([]);
    expect(saidLines([{ question: "One?", answer: "" }])).toEqual([]);
  });
});

describe("a late answer, as the host's turn", () => {
  it("knows the host's turn by its id, and no person's", () => {
    expect(isAnswerTurn("octiq-question-7f3a")).toBe(true);
    expect(isAnswerTurn("octiq-complete-7f3a")).toBe(false);
    expect(isAnswerTurn("3f0c9c1e-1b0b-4d5b-9d6c-0c7d6e0a5b11")).toBe(false);
    expect(isAnswerTurn(undefined)).toBe(false);
  });

  it("reads the questions and answers the host wrote", () => {
    expect(answerTurn(continuation([["Which database?", "SQLite"], ["Name?", "octiq"]]))).toEqual([
      { question: "Which database?", answer: "SQLite" }, { question: "Name?", answer: "octiq" },
    ]);
  });

  it("keeps an answer of several lines whole, and stops at the host's own sentence", () => {
    const [only] = answerTurn(continuation([["Notes?", "First line\n\nSecond line"]]))!;
    expect(only.answer).toBe("First line\n\nSecond line");
  });

  it("does not put a machine's sentence in the person's mouth", () => {
    const read = answerTurn(continuation([["One?", "Not answered"], ["Two?", "The user closed this question without answering. Do not assume an answer."]]))!;
    expect(read.map((item) => item.answer)).toEqual(["", ""]);
    expect(read.every((item) => item.unanswered)).toBe(true);
  });

  it("is nothing for words that are not the host's answer turn", () => {
    expect(answerTurn("Please carry on.")).toBeNull();
    const typed: Message = { id: "u1", role: "user", turnId: "t-1", streaming: false, blocks: [{ kind: "text", text: continuation([["One?", "Yes"]]) }] };
    // The same words under a person's turn id are a message of theirs.
    expect(answerTurnOf(typed)).toBeNull();
    expect(answerTurnOf({ ...typed, turnId: "octiq-question-r1" })).toEqual([{ question: "One?", answer: "Yes" }]);
  });

  it("is found again by the call that ended still waiting", () => {
    const messages: Message[] = [
      said("m1", [call("t1", ["Which database?"], NOT_IN_TIME)]),
      { id: "u1", role: "user", turnId: "octiq-question-r1", streaming: false, blocks: [{ kind: "text", text: continuation([["Which database?", "SQLite"]]) }] },
    ];
    const late = lateAnswers(messages);
    const asked = askAnswer(ASK, { question: "Which database?" }, NOT_IN_TIME)!;
    expect(asked[0].later).toBe(true);
    expect(lateAnswerTo(late, asked)).toEqual([{ question: "Which database?", answer: "SQLite" }]);
    // A call that was answered in its own turn has no late answer to look for.
    expect(lateAnswerTo(late, askAnswer(ASK, { question: "Which database?" }, "Postgres")!)).toBeNull();
  });
});

describe("the words for a batch", () => {
  it("counts the questions waiting out of view", () => {
    expect(waitingLabel(1)).toBe("1 question waiting");
    expect(waitingLabel(3)).toBe("3 questions waiting");
  });

  it("never says saved of answers that are not on disk", () => {
    const of = (over: Partial<Question>) => answeredNote(batchesOf([q("a", "One?", { answer: "Yes", ...over })])[0]);
    expect(of({ status: "saved" })).toEqual({ title: "Answers saved · waiting for the agent", tone: "quiet" });
    expect(of({ status: "delivered", unsaved: "The profile folder is not available right now." })).toEqual({
      title: "Answers sent · not saved", tone: "warn", why: "The profile folder is not available right now.",
    });
    expect(of({ status: "failed", error: "Could not continue the agent" })).toEqual({
      title: "Answers need attention", tone: "warn", why: "Could not continue the agent",
    });
    expect(answeredNote(batchesOf([q("a", "One?", { status: "pending" })])[0])).toBeNull();
  });
});
