// A block is whole before it can be sent, and nothing this page remembers
// stands in for a question that has no answer (review 3, H4).
//
// The host says how many questions a call carried (`batchSize`) and sends
// them one event each. A block used to be sendable with one of two
// arrived; the host took that one answer and went on waiting for the
// other, which then arrived under a block that only said what had been
// sent. The lists below are the page's question list at each step of the
// reviewer's probe (`review-3/partial-batch-probe.mjs`): what
// `user-question` and `question-updated` leave in it, in that order.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({ knownPath: () => undefined, askPaths: () => {}, subscribePaths: () => () => {} }));

import source from "./InlineQuestions.tsx?raw";
import type { Block, Message } from "../lib/chat";
import type { Question } from "../lib/question";
import { batchesOf, batchParts, partNote, readingReason, submitReason } from "../lib/questionBlock";
import { ChatQuestionsContext } from "./InlineQuestions";
import { MessageList } from "./MessageList";

const reply = (id: string, blocks: Block[]): Message => ({ id, role: "assistant", blocks, streaming: false });
const TALK = [reply("m1", [{ kind: "text", text: "Two things before I go on." }])];
const chat = (questions: Question[], messages: Message[] = TALK) => renderToStaticMarkup(
  <ChatQuestionsContext.Provider value={{ questions, onDone: () => {} }}>
    <MessageList messages={messages} busy={false} conversationId="c1" />
  </ChatQuestionsContext.Provider>,
);
const submit = (html: string) => /<button type="button" class="qa-submit"[^>]*>[^<]*<\/button>/.exec(html)?.[0] ?? "";
const titles = (html: string) => [...html.matchAll(/<p class="qa-q-title"[^>]*>([^<]*)<\/p>/g)].map((match) => match[1]);
const bubbles = (html: string) => [...html.matchAll(/<p class="qa-said-line[^"]*">(.*?)<\/p>/g)].map((match) => match[1].replace(/<[^>]+>/g, ""));

/** The reviewer's two questions, as their probe listed them: one call of
 *  two, each with a recommended option. `batch` is this test's own. */
const pair = (batch: string, over: Partial<Question> = {}) => {
  const a: Question = { id: `${batch}-1`, chatKey: "chat:c1", batch, batchSize: 2, question: "Which branch?", options: ["develop", "main"], recommended: 0, ...over };
  const b: Question = { id: `${batch}-2`, chatKey: "chat:c1", batch, batchSize: 2, question: "Which target?", options: ["staging", "production"], recommended: 0, ...over };
  return [a, b] as const;
};

describe("a call whose questions have not all arrived", () => {
  it("says how many are missing, by what this page was told", () => {
    const [a, b] = pair("count");
    expect(batchesOf([a])).toEqual([{ key: "count", questions: [a], missing: 1 }]);
    expect(batchesOf([a, b])[0].missing).toBe(0);
    // A question asked alone, and one from a host that names no size.
    expect(batchesOf([{ id: "alone", question: "Ship?" }])[0].missing).toBe(0);
    expect(batchesOf([{ id: "old-1", batch: "old", question: "Ship?" }])[0].missing).toBe(0);
  });

  it("is not to be sent, whatever is already selected, and says it is still reading", () => {
    const [a] = pair("reason");
    // The recommended option answers the one question that is here.
    expect(submitReason([a], {})).toBeNull();
    expect(submitReason([a], {}, 1)).toBe("Still reading the questions: 1 of 2 has arrived.");
    expect(readingReason(1, 2)).toBe("Still reading the questions: 1 of 2 has arrived.");
    expect(readingReason(2, 5)).toBe("Still reading the questions: 2 of 5 have arrived.");
  });

  it("is drawn with its button off and the reason under it, as the first event leaves it", () => {
    const [a] = pair("first");
    const html = chat([a]);
    expect(titles(html)).toEqual(["Which branch?"]);
    expect(submit(html)).toContain('aria-disabled="true"');
    expect(html).toMatch(/<p class="qa-why" id="[^"]+">Still reading the questions: 1 of 2 has arrived\.<\/p>/);
    // The handler refuses it too: the reason is asked before anything is sent.
    expect(source).toMatch(/const reason = submitReason\(questions, picks, batch\.missing\);/);
    expect(source).toMatch(/const submit = async \(\) => \{\s*if \(sending \|\| reason\) return;/);
  });

  it("is whole, and can be sent, once the last has arrived", () => {
    const [a, b] = pair("whole");
    chat([a]);
    const html = chat([a, b]);
    expect(titles(html)).toEqual(["Which branch?", "Which target?"]);
    expect(submit(html)).toContain('aria-disabled="false"');
    expect(submit(html)).toContain(">Send 2 answers<");
    expect(html).not.toContain("Still reading");
  });

  it("stays whole when the page itself drops an answered question of an older host", () => {
    // An older host keeps no record: the page takes a delivered answer off
    // its own list. What is left of the call has all arrived.
    const [a, b] = pair("legacy", { status: undefined });
    chat([a, b]);
    const html = chat([b]);
    expect(titles(html)).toEqual(["Which target?"]);
    expect(submit(html)).toContain('aria-disabled="false"');
  });
});

describe("a call that is answered in part", () => {
  it("draws what is answered and asks what is not, as the reviewer's second step leaves the list", () => {
    // `question-updated` for the first (saved, with its answer), then
    // `user-question` for the second. Their probe read: no form, no title,
    // one bubble. The agent was waiting on the second.
    const [a, b] = pair("race");
    const html = chat([{ ...a, status: "saved", answer: "develop" }, b]);
    expect(titles(html)).toEqual(["Which target?"]);
    expect(html.match(/class="qa-block/g)).toHaveLength(1);
    expect(submit(html)).toContain('aria-disabled="false"');
    expect(submit(html)).toContain(">Send answer<");
    // What was answered is said, with its question, above what is asked.
    expect(html).toContain('<p class="qa-asked-q">Which branch?</p>');
    expect(bubbles(html)).toEqual(["Which branch? develop"]);
    expect(html.indexOf("qa-said")).toBeLessThan(html.indexOf("qa-block"));
    expect(html).toContain("Answered · the agent waits for 1 more question");
    // Never "saved" of a record the host has not called whole.
    expect(html).not.toMatch(/Answers saved/);
  });

  it("is the same for a partial record as the host really lists it: every member pending, one with an answer", () => {
    // `question_store::Record::views`: a record is `saved` only when every
    // question has an answer. Until then all are `pending`.
    const [a, b] = pair("partial", { status: "pending" });
    const html = chat([{ ...a, answer: "develop" }, b]);
    expect(titles(html)).toEqual(["Which target?"]);
    expect(bubbles(html)).toEqual(["Which branch? develop"]);
    expect(submit(html)).toContain('aria-disabled="false"');
    // The badge still finds the block: the call still asks.
    expect(html).toContain('data-pending-keys="question:partial"');
  });

  it("reads what this page sent only for the questions it was sent for", () => {
    const [a, b] = pair("sent");
    const [batch] = batchesOf([a, b]);
    // Nothing sent: both are asked.
    expect(batchParts(batch)).toEqual({ said: [], open: [a, b] });
    // The first was sent from here and the host has not said so yet: the
    // second is still asked. This is what the old `sent` branch hid.
    expect(batchParts(batch, [a.id])).toEqual({ said: [a], open: [b] });
    // The host's answer counts without anything this page remembers.
    const [heard] = batchesOf([{ ...a, answer: "develop" }, b]);
    expect(batchParts(heard).open).toEqual([b]);
    expect(batchParts(heard, [a.id, b.id]).open).toEqual([]);
    expect(source).toMatch(/const \{ said, open \} = batchParts\(batch, sent\?\.ids\);/);
    // No branch of the block returns on `sent` alone.
    expect(source).not.toMatch(/if \(sent\) return/);
  });

  it("says how much the agent still waits for", () => {
    expect(partNote(1, 1).title).toBe("Answered · the agent waits for 1 more question");
    expect(partNote(2, 3).title).toBe("2 answered · the agent waits for 3 more questions");
  });

  it("is a record once every question has an answer", () => {
    const [a, b] = pair("done", { status: "saved" });
    const html = chat([{ ...a, answer: "develop" }, { ...b, answer: "staging" }]);
    expect(html).not.toContain("qa-block");
    expect(html).toContain("Answers saved · waiting for the agent");
    expect(bubbles(html)).toEqual(["Which branch? develop", "Which target? staging"]);
  });
});
