// A delivered question stays in the conversation (review 3, H3).
//
// The answer bubble of a question with no `ask_user` call the page draws
// (Codex's own request, a call behind `Load earlier messages`) was this
// page's own memory: it went when the host said `question-expired`, and a
// reload never had it. The host now writes one `octiq_question_answered`
// line into the chat's record when an answer is handed over while its call
// waits, and the transcript draws the answered question from that line.
//
// The lines here are the two the host's own tests wrote
// (`__fixtures__/host/question_answered_*.json`), reduced by the page's own
// reducer, so what is drawn is what a reload and a second tab draw.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({ knownPath: () => undefined, askPaths: () => {}, subscribePaths: () => () => {} }));

import source from "./InlineQuestions.tsx?raw";
import listSource from "./MessageList.tsx?raw";
import { hostFacts } from "../lib/__fixtures__/hostFacts";
import { emptyChat, reduceChat, type Block, type ChatState, type Message } from "../lib/chat";
import { answeredMessageId, readQuestionAnswered, type Question, type QuestionAnswered } from "../lib/question";
import { ANSWER_TURN_PREFIX, placeAnswered } from "../lib/questionBlock";
import { ChatQuestionsContext } from "./InlineQuestions";
import { MessageList } from "./MessageList";

const ASK = "mcp__octiq__ask_user";
const reply = (id: string, blocks: Block[]): Message => ({ id, role: "assistant", blocks, streaming: false });
const call = (id: string, line: QuestionAnswered, result?: string): Block => ({
  kind: "tool", id, name: ASK, argsJson: "{}", args: { questions: line.questions.map((q) => ({ question: q.question, options: q.options })) },
  result, state: result === undefined ? "running" : "done",
}) as Block;
/** What the tool's result says for a line's answers. */
const resultOf = (line: QuestionAnswered) => line.questions.map((q, i) => `Q${i + 1}: ${q.question}\nA${i + 1}: ${q.answer}`).join("\n\n");

/** A chat's state after these messages and then these lines of its record. */
const heard = (messages: Message[], ...lines: unknown[]): ChatState =>
  lines.reduce<ChatState>((state, line) => reduceChat(state, line as Parameters<typeof reduceChat>[1]), { ...emptyChat(), messages });

const chat = (messages: readonly Message[], questions: Question[] = []) => renderToStaticMarkup(
  <ChatQuestionsContext.Provider value={{ questions, onDone: () => {} }}>
    <MessageList messages={[...messages]} busy={false} conversationId="c1" />
  </ChatQuestionsContext.Provider>,
);
const readOnly = (messages: readonly Message[]) => renderToStaticMarkup(<MessageList messages={[...messages]} busy={false} />);
const bubbles = (html: string) => [...html.matchAll(/<div class="qa-said-body"[^>]*>(.*?)<\/div>/g)]
  .map((match) => [...match[1].matchAll(/<p class="qa-said-line[^"]*">(.*?)<\/p>/g)].map((line) => line[1].replace(/<[^>]+>/g, "")));
const asked = (html: string) => [...html.matchAll(/<p class="qa-asked-q">([^<]*)<\/p>/g)].map((match) => match[1]);

const TALK = [reply("m1", [{ kind: "text", text: "Two things before I tag it." }])];
const NATIVE_SAID = ["Which branch should this go to? develop", "What should the tag be called? v0.3.11"];

describe("the answered line, in the chat's state", () => {
  it("is one item of the transcript for a record, however often it is heard", () => {
    const line = hostFacts.questionAnsweredNative();
    const once = heard(TALK, line);
    expect(once.messages.map((m) => m.id)).toEqual(["m1", answeredMessageId(line.id)]);
    expect(once.messages[1]).toMatchObject({ role: "assistant", streaming: false, blocks: [{ kind: "answered", answered: { id: line.id, via: "native" } }] });
    // A write that failed is tried again and said again.
    const twice = reduceChat(once, line as never);
    expect(twice).toBe(once);
    // It is at the end of what the record held when it was written, so what
    // the agent says next follows it.
    const then = heard(TALK, line, hostFacts.questionAnsweredTool());
    expect(then.messages.map((m) => m.id)).toEqual(["m1", answeredMessageId(line.id), answeredMessageId(hostFacts.questionAnsweredTool().id)]);
  });

  it("keeps the host's strings as text and draws nothing of a line that is not whole", () => {
    const line = hostFacts.questionAnsweredNative();
    expect(readQuestionAnswered(line)).toEqual(line);
    expect(readQuestionAnswered(hostFacts.questionAnsweredTool())).toEqual(hostFacts.questionAnsweredTool());
    for (const broken of [
      { ...line, id: "" }, { ...line, questions: [] }, { ...line, questions: "x" }, { ...line, type: "octiq_other" },
      { ...line, questions: [{ ...line.questions[0], answer: 7 }] }, { ...line, questions: [{ id: "x", answer: "develop" }] }, null, "line",
    ]) {
      expect(readQuestionAnswered(broken), JSON.stringify(broken)).toBeNull();
      if (!broken || typeof broken !== "object" || (broken as { type?: string }).type !== "octiq_question_answered") continue;
      const before = heard(TALK);
      expect(reduceChat(before, broken as never), JSON.stringify(broken)).toBe(before);
    }
    const markup = { ...line, questions: [{ ...line.questions[0], question: "<b>Which</b> branch?", answer: "<img src=x onerror=alert(1)>" }] };
    const html = chat(heard(TALK, markup).messages);
    expect(html).toContain("&lt;b&gt;Which&lt;/b&gt; branch?");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
  });
});

describe("a question the provider asked by itself", () => {
  const line = hostFacts.questionAnsweredNative();

  it("is drawn from the line where the line stands: what was asked, and the person's bubble", () => {
    // No pending question is left: this is the page after `question-expired`,
    // after a reload, and in a tab that never saw the question.
    const messages = heard(TALK, line).messages;
    const html = chat(messages);
    expect(html).toContain(`<div class="qa-turn is-answered" data-answered="${line.id}">`);
    expect(asked(html)).toEqual(["Which branch should this go to?", "What should the tag be called?"]);
    expect(html).toContain("Asked 2 questions");
    expect(bubbles(html)).toEqual([NATIVE_SAID]);
    // After what the agent said before it, and before what it says next.
    const went = chat([...messages, reply("m2", [{ kind: "text", text: "Tagging develop as v0.3.11." }])]);
    expect(went.indexOf("Two things before I tag it.")).toBeLessThan(went.indexOf("qa-asked"));
    expect(went.indexOf("qa-said")).toBeLessThan(went.indexOf("Tagging develop as v0.3.11."));
    expect(bubbles(went)).toEqual([NATIVE_SAID]);
  });

  it("is drawn once while the host still lists the question it answers", () => {
    // The line is heard before `question-expired`: for that moment the page
    // holds both the record's line and the pending question, saved.
    const listed: Question[] = line.questions.map((q) => ({
      id: q.id, chatKey: "chat:c1", batch: line.id, batchSize: line.questions.length, question: q.question, options: q.options, answer: q.answer, status: "saved",
    }));
    const before = chat(TALK, listed);
    expect(bubbles(before)).toEqual([NATIVE_SAID]);
    expect(before).toContain("qa-turn is-loose");
    const during = chat(heard(TALK, line).messages, listed);
    expect(bubbles(during)).toEqual([NATIVE_SAID]);
    expect(during).not.toContain("qa-turn is-loose");
    expect(during).toContain("qa-turn is-answered");
    // And the same once the host has stopped listing it.
    expect(bubbles(chat(heard(TALK, line).messages))).toEqual([NATIVE_SAID]);
  });

  it("is the same where nobody can answer", () => {
    expect(bubbles(readOnly(heard(TALK, line).messages))).toEqual([NATIVE_SAID]);
  });

  it("is not a message: nothing on it acts, it is no turn of the person's and no point on the map", () => {
    const html = chat(heard(TALK, line).messages);
    // The record's own block, up to the reply's footer (the copy there is
    // the reply's, and copies its prose).
    const from = html.indexOf("qa-turn is-answered");
    const part = html.slice(from, html.indexOf('<div class="msg-foot">', from));
    expect(part).toContain("v0.3.11");
    expect(part).not.toMatch(/<button|message-delivery|msg-copy|data-map-turn|qa-block|<input/);
    expect(html).not.toContain("msg-user");
    // The transcript item is the host's, in the reply's own column: it is
    // never grouped as a person's turn, and the map draws only those.
    expect(heard(TALK, line).messages[1].role).toBe("assistant");
    expect(listSource).toMatch(/mapTurnId=\{turn\[0\]\.role === "user" && !isAnswerTurn\(turn\[0\]\.turnId\) \? turn\[0\]\.id : undefined\}/);
    expect(html).not.toContain("data-map-turn");
    // No name over a block that is only the host's record.
    expect(listSource).toMatch(/b\.kind === "reopened" \|\| b\.kind === "answered"\);/);
    expect(source).toMatch(/export function AnsweredInline\(\{ answered \}: \{ answered: QuestionAnswered \}\) \{[\s\S]*?<Asked items=\{items\} \/>\s*<AnswerBubble lines=\{saidLines\(items\)\} \/>/);
  });
});

describe("a question asked through the tool", () => {
  const line = hostFacts.questionAnsweredTool();
  const SAID = ["Which database? SQLite", "Which checks should run? cargo test, pnpm test"];

  it("is drawn once, at its call, from the call's result: the line draws nothing", () => {
    // The line is written between the call and its result.
    const state = heard([reply("m1", [call("t1", line, resultOf(line))])], line);
    const where = placeAnswered(state.messages);
    expect([...where.byTool.keys()]).toEqual(["t1"]);
    expect(where.atLine.size).toBe(0);
    const html = chat(state.messages);
    expect(bubbles(html)).toEqual([SAID]);
    expect(html).not.toContain("qa-turn is-answered");
    expect(asked(html)).toEqual(["Which database?", "Which checks should run?"]);
  });

  it("is drawn at its call from the line before the result is in, in every tab", () => {
    // The call still waits on the page; the question is gone from the list.
    // A tab that did not send the answer has no memory of it.
    const state = heard([reply("m1", [call("t1", line)])], line);
    const html = chat(state.messages);
    expect(bubbles(html)).toEqual([SAID]);
    expect(html).not.toContain("qa-turn is-answered");
    expect(html).not.toContain("Asking a question");
    expect(source).toMatch(/\} else if \(recorded\) \{[\s\S]*?body = <><Asked items=\{recorded\} \/><AnswerBubble lines=\{saidLines\(recorded\)\} \/><\/>;/);
  });

  it("is drawn where the line stands when these turns hold no call for it", () => {
    // A subagent's call, a call behind Load earlier messages, a provider
    // whose call the page does not recognise.
    const html = chat(heard(TALK, line).messages);
    expect(html).toContain("qa-turn is-answered");
    expect(bubbles(html)).toEqual([SAID]);
  });

  it("gives each of two calls in the same words its own line", () => {
    const again = { ...line, id: "second-record", questions: line.questions.map((q) => ({ ...q, id: `${q.id}-2`, answer: q.answer === "SQLite" ? "Postgres" : q.answer })) };
    const state = heard([reply("m1", [call("t1", line)])], line);
    const both = heard([...state.messages, reply("m2", [call("t2", line)])], again);
    const where = placeAnswered(both.messages);
    expect(where.byTool.get("t1")?.map((item) => item.answer)).toEqual(["SQLite", "cargo test, pnpm test"]);
    expect(where.byTool.get("t2")?.map((item) => item.answer)).toEqual(["Postgres", "cargo test, pnpm test"]);
    expect(where.atLine.size).toBe(0);
    expect(bubbles(chat(both.messages))).toEqual([SAID, ["Which database? Postgres", "Which checks should run? cargo test, pnpm test"]]);
  });
});

describe("a record that has both the line and the host's late turn", () => {
  it("draws the turn's bubble and nothing for the line", () => {
    // The rare one: the hand-over was owed with the profile folder away,
    // the server restarted, and the answer then went as the host's turn.
    const line = hostFacts.questionAnsweredNative();
    const turn: Message = {
      id: "u9", role: "user", turnId: `${ANSWER_TURN_PREFIX}${line.id}`, streaming: false, echo: "x",
      blocks: [{
        kind: "text",
        text: `The user answered your saved OctiqFlow questions (request ${line.id}).\n\n` +
          line.questions.map((q, i) => `Q${i + 1}: ${q.question}\nA${i + 1}: ${q.answer}`).join("\n\n") +
          "\n\nContinue the original task using these answers and the conversation context.",
      }],
    };
    const state = heard([...TALK, turn], line);
    expect(placeAnswered(state.messages).atLine.size).toBe(0);
    const html = chat(state.messages);
    expect(bubbles(html)).toEqual([NATIVE_SAID]);
    expect(html).not.toContain("qa-turn is-answered");
  });
});
