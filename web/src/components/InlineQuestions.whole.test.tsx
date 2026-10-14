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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({ knownPath: () => undefined, askPaths: () => {}, subscribePaths: () => () => {} }));

import source from "./InlineQuestions.tsx?raw";
import type { Block, Message } from "../lib/chat";
import type { Question } from "../lib/question";
import requestsRaw from "../lib/useChatRequests.ts?raw";
import { LISTED_GRACE_MS, batchesOf, batchParts, keepBatches, knownBatches, listedQuestions, partNote, readingReason, stillMissing, submitReason } from "../lib/questionBlock";
import { answersOneAtATime } from "../lib/questionHost";
import { submitQuestionAnswers } from "../lib/submitQuestionAnswers";
import { fakeLocalStorage } from "../lib/__fixtures__/fakeLocalStorage";
import { lf } from "../lib/sourceText";

const requests = lf(requestsRaw);
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
    expect(source).toMatch(/const reason = submitReason\(questions, picks, stillMissing\(batch, Date\.now\(\)\)\);/);
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

describe("a part of a call that the host's own list named", () => {
  // Review 3b. A host older than the durable store has no batch command, so
  // the page answers one question at a time and that host drops each as it
  // is answered. The first of two went through and the second's send
  // failed; after a reload the host lists the second alone, still with
  // `batchSize: 2`. Counted against what this page had seen arrive (nothing,
  // after a reload), the block said `Still reading the questions: 1 of 2
  // has arrived` for good, and its button never came on.
  const NOW = 1_800_000_000_000;
  const at = (now: number) => vi.setSystemTime(now);
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); at(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("is whole at once on a host that answers one question at a time: the reload after a part went through", () => {
    const [, b] = pair("legacy-reload", { status: undefined });
    // The page as it was: the list's answer counted like an event, for good.
    expect(batchesOf([b])[0]).toEqual({ key: "legacy-reload", questions: [b], missing: 1 });
    keepBatches([]);
    // The list answers, and the page knows what kind of host answered.
    listedQuestions([b], NOW, true);
    expect(batchesOf([b])).toEqual([{ key: "legacy-reload", questions: [b], missing: 0 }]);
    const html = chat([b]);
    expect(titles(html)).toEqual(["Which target?"]);
    expect(submit(html)).toContain('aria-disabled="false"');
    expect(submit(html)).toContain(">Send answer<");
    expect(html).not.toContain("Still reading");
  });

  it("is held for the rest on any other host, as the first of two arriving is: the reviewer's partial probe", () => {
    // Their probe puts one of two in the list at page load, on a host that
    // has the batch command, and presses: nothing may be sent.
    const [a, b] = pair("listed-part");
    listedQuestions([a], NOW);
    const [batch] = batchesOf([a]);
    expect(batch).toEqual({ key: "listed-part", questions: [a], missing: 1, until: NOW + LISTED_GRACE_MS });
    expect(stillMissing(batch, NOW)).toBe(1);
    expect(stillMissing(batch, NOW + LISTED_GRACE_MS - 1)).toBe(1);
    at(NOW + 2_000);
    const html = chat([a]);
    expect(submit(html)).toContain('aria-disabled="true"');
    expect(html).toContain("Still reading the questions: 1 of 2 has arrived.");
    // The second arrives: whole, and nothing left to wait out.
    expect(batchesOf([a, b])[0]).toEqual({ key: "listed-part", questions: [a, b], missing: 0 });
    expect(submit(chat([a, b]))).toContain('aria-disabled="false"');
  });

  it("is never held for good: `batchSize` delays a send and does not forbid one", () => {
    // A host this browser has not yet sent to, that lists one of two and
    // sends nothing more: the older host met by a fresh browser, or by a
    // second device after the first answered a part.
    const [, b] = pair("listed-for-good", { status: undefined });
    listedQuestions([b], NOW);
    const [batch] = batchesOf([b]);
    expect(stillMissing(batch, NOW + LISTED_GRACE_MS)).toBe(0);
    at(NOW + LISTED_GRACE_MS - 1);
    expect(submit(chat([b]))).toContain('aria-disabled="true"');
    at(NOW + LISTED_GRACE_MS);
    const html = chat([b]);
    expect(submit(html)).toContain('aria-disabled="false"');
    expect(html).not.toContain("Still reading");
    // The block draws itself again when that wait is over, by itself.
    expect(source).toMatch(/const waitOver = batch\.missing > 0 \? batch\.until : undefined;/);
    expect(source).toMatch(/const timer = setTimeout\(\(\) => redraw\(\(n\) => n \+ 1\), left \+ 20\);\s*return \(\) => clearTimeout\(timer\);\s*\}, \[waitOver\]\);/);
    expect(source).toMatch(/const reason = submitReason\(questions, picks, stillMissing\(batch, Date\.now\(\)\)\);/);
    // A later read of the list does not start the wait over.
    listedQuestions([b], NOW + 60_000);
    expect(batchesOf([b])[0].until).toBe(NOW + LISTED_GRACE_MS);
  });

  it("is told by the one place the list is read, with what the page knows of the host", () => {
    expect(requests).toMatch(/refill\(prompts, "question_pending", \(list\) => \{\s*listedQuestions\(list \?\? \[\], Date\.now\(\), answersOneAtATime\(\)\);\s*return \[\.\.\.\(list \?\? \[\]\)\];\s*\}\),/);
    expect(requests.match(/listedQuestions\(/g)).toHaveLength(1);
  });

  it("is the same for a durable host's reload in the middle of a call: one answered, one asked", () => {
    // That host lists every question of a record until the record is whole.
    const [a, b] = pair("durable-reload", { status: "pending" });
    const list = [{ ...a, answer: "develop" }, b];
    listedQuestions(list, NOW);
    expect(batchesOf(list)[0]).toEqual({ key: "durable-reload", questions: list, missing: 0 });
    const html = chat(list);
    expect(titles(html)).toEqual(["Which target?"]);
    expect(bubbles(html)).toEqual(["Which branch? develop"]);
    expect(submit(html)).toContain('aria-disabled="false"');
    expect(html).not.toContain("Still reading");
  });

  it("still holds a call whose questions arrive in two events before the list is read", () => {
    const [a, b] = pair("two-events");
    // The first event, on a connection whose list has not answered: held,
    // with no end to wait out. The second ends it.
    expect(batchesOf([a])[0]).toEqual({ key: "two-events", questions: [a], missing: 1 });
    let html = chat([a]);
    expect(submit(html)).toContain('aria-disabled="true"');
    expect(html).toContain("Still reading the questions: 1 of 2 has arrived.");
    at(NOW + 3_600_000);
    expect(submit(chat([a]))).toContain('aria-disabled="true"');
    html = chat([a, b]);
    expect(submit(html)).toContain('aria-disabled="false"');
    expect(html).not.toContain("Still reading");
    // Then the list, naming both: nothing changes.
    listedQuestions([a, b], NOW + 3_600_000);
    expect(batchesOf([a, b])[0].missing).toBe(0);
  });

  it("still holds a call that arrives after a list that did not name it", () => {
    // The usual live case: the list was read long ago, and a new call's
    // questions come one event each. A read list is not a licence for every
    // later call, on either kind of host.
    listedQuestions([{ id: "elsewhere", chatKey: "chat:c1", question: "Ship?" }], NOW - 3_600_000, true);
    const [a, b] = pair("after-list");
    expect(batchesOf([a])[0]).toEqual({ key: "after-list", questions: [a], missing: 1 });
    const html = chat([a]);
    expect(submit(html)).toContain('aria-disabled="true"');
    expect(html).toContain("Still reading the questions: 1 of 2 has arrived.");
    expect(submit(chat([a, b]))).toContain('aria-disabled="false"');
  });
});

describe("what the page knows of the host", () => {
  const invokeOn = (legacy: boolean, fail?: string) => async (command: string, args: Record<string, unknown>) => {
    if (command === "question_answer_batch") {
      if (legacy) throw new Error("'question_answer_batch' is not available on this backend");
      return { saved: true };
    }
    if (args.id === fail) throw new Error("transport failed on the second answer");
    return true;
  };
  const answers = [{ id: "legacy-1", answer: "develop" }, { id: "legacy-2", answer: "staging" }];
  beforeEach(() => { fakeLocalStorage(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is learned by sending, and remembered before the first answer goes: a part can fail", async () => {
    expect(answersOneAtATime()).toBe(false);
    // The reviewer's case: the first is taken, the second's send fails.
    await expect(submitQuestionAnswers(invokeOn(true, "legacy-2"), answers)).rejects.toThrow("transport failed");
    expect(answersOneAtATime()).toBe(true);
    // What a reload reads back.
    expect(localStorage.getItem("octiq.v2.questionsOneAtATime")).toBe("1");
  });

  it("is forgotten the first time the batch command answers: an upgraded host is not called old", async () => {
    await submitQuestionAnswers(invokeOn(true), answers);
    expect(answersOneAtATime()).toBe(true);
    expect(await submitQuestionAnswers(invokeOn(false), answers)).toBe("saved");
    expect(answersOneAtATime()).toBe(false);
    expect(localStorage.getItem("octiq.v2.questionsOneAtATime")).toBeNull();
  });

  it("is not learned from a failure that says nothing of the host", async () => {
    const down = async () => { throw new Error("socket closed"); };
    await expect(submitQuestionAnswers(down, answers)).rejects.toThrow("socket closed");
    expect(answersOneAtATime()).toBe(false);
    // Storage that cannot be read is a host not known to be old.
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    expect(answersOneAtATime()).toBe(false);
    await submitQuestionAnswers(invokeOn(true), answers);
    expect(answersOneAtATime()).toBe(false);
  });
});

describe("what the page counts of a call", () => {
  it("is forgotten when no question of the call is left on the page", () => {
    keepBatches([]);
    expect(knownBatches()).toBe(0);
    const [a, b] = pair("forget-1");
    const [c, d] = pair("forget-2");
    batchesOf([a, b, c, d]);
    expect(knownBatches()).toBe(2);
    // The first call's record completes: its questions leave the page.
    keepBatches([c, d]);
    expect(knownBatches()).toBe(1);
    // Every chat's history cleared.
    keepBatches([]);
    expect(knownBatches()).toBe(0);
  });

  it("is kept while one question of the call is: the older host's guard survives the forgetting", () => {
    const [a, b] = pair("forget-legacy", { status: undefined });
    batchesOf([a, b]);
    // The page drops the first itself; the second is still held.
    keepBatches([b]);
    expect(batchesOf([b])[0].missing).toBe(0);
    // And a list's word is kept as long.
    const [, y] = pair("forget-listed", { status: undefined });
    listedQuestions([y], 1, true);
    keepBatches([b, y]);
    expect(batchesOf([y])[0].missing).toBe(0);
  });

  it("is forgotten by the page as its question list changes", () => {
    expect(requests).toMatch(/useEffect\(\(\) => \{ keepBatches\(Object\.values\(questions\)\.flat\(\)\); \}, \[questions\]\);/);
  });
});
