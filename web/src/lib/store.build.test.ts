// A transcript an earlier reader drew is carried forward, never thrown away.
//
// The store keeps whole transcripts — `Message[]`, already reduced — and a
// reload paints them synchronously, then asks the server only for what came
// after `seq`. So a change to how events become messages is invisible in every
// chat already in here.
//
// Blanking them is the worse cure: the chat drops onto the paginated load
// path, the server serves only its last few turns, and every re-cache path is
// gated on `hasEarlier`, so it pages for ever and the rest never returns. See
// lib/cacheMigration.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Conversation } from "./store";
import { CONVERSATIONS_KEY, loadConversations, saveConversations } from "./store";
import { fakeLocalStorage } from "./__fixtures__/fakeLocalStorage";

let held: Map<string, string>;

beforeEach(() => { held = fakeLocalStorage(); });
afterEach(() => vi.unstubAllGlobals());

/** A hand-back as the OLD reader cached it: a user bubble whose one text block
 *  still holds the whole frame. That the frame survives in the text is what
 *  makes the migration possible without the original events. */
const FRAME =
  '<agent-message from="ac73ceeede1748538">\n' +
  "[Subagent hand-back] The report follows:\n" +
  "  Verdict — APPROVE WITH FOLLOW-UP\n" +
  "</agent-message>";

const chat = (): Conversation => ({
  id: "c1",
  projectId: "p1",
  title: "a chat with a subagent in it",
  messages: [
    { id: "m1", role: "user", streaming: false, blocks: [{ kind: "text", text: "have a look" }] },
    { id: "m2", role: "user", streaming: false, blocks: [{ kind: "text", text: FRAME }] },
  ],
  createdAt: 1,
  updatedAt: 2,
  seq: 7708,
});

/** Rewrite the stored rows' stamp, standing in for what an EARLIER reader left
 *  behind. Raw, because the stamp is the store's own business. */
function restamp(stamp: Record<string, unknown>): void {
  const rows = JSON.parse(held.get(CONVERSATIONS_KEY) || "[]");
  held.set(CONVERSATIONS_KEY, JSON.stringify(rows.map((r: object) => ({ ...r, ...stamp }))));
}

it("leaves a transcript this reader drew exactly as it is", () => {
  saveConversations([chat()]);

  const [back] = loadConversations();
  expect(back.messages).toHaveLength(2);
  expect(back.messages[1].role).toBe("user");
  expect(back.seq).toBe(7708);
});

it("redraws a peer's words an earlier reader drew as a bubble", () => {
  saveConversations([chat()]);
  restamp({ schema: 1 });

  const [back] = loadConversations();
  expect(back.messages[1]).toMatchObject({
    role: "assistant",
    blocks: [{ kind: "peer", source: "handback", from: "ac73ceeede1748538" }],
  });
});

it("leaves a frame the person sent as their own message", () => {
  // Sent (`turnId`) is the record of OctiqFlow sending a prompt the person
  // typed. A frame pasted into the composer is still their words.
  const typed = chat();
  typed.messages = [
    { id: "m1", role: "user", streaming: false, turnId: "t1", blocks: [{ kind: "text", text: FRAME }] },
  ];
  saveConversations([typed]);
  restamp({ schema: 1 });

  const [back] = loadConversations();
  expect(back.messages[0]).toMatchObject({ role: "user", blocks: [{ kind: "text", text: FRAME }] });
});

it("redraws a hand-back that carries nothing but an echo", () => {
  // Every turn rebuilt from the record is stamped `echo`, a subagent's
  // hand-back included, so an echo proves nothing about who typed it. Before
  // 6ea80b0 this is exactly how a report was cached: a user bubble, echoed.
  const echoed = chat();
  echoed.messages = [
    { id: "m1", role: "user", streaming: false, echo: "u2", blocks: [{ kind: "text", text: FRAME }] },
  ];
  saveConversations([echoed]);
  restamp({ schema: 1 });

  const [back] = loadConversations();
  expect(back.messages[0]).toMatchObject({
    id: "m1",
    role: "assistant",
    blocks: [{ kind: "peer", source: "handback", from: "ac73ceeede1748538" }],
  });
});

it("keeps `seq`, so the chat still resumes where it did", () => {
  // The whole reason not to blank. Without `seq` the chat reloads from zero,
  // which means the PAGED path — the last few turns and nothing else, for
  // ever, because a paged chat never re-caches.
  saveConversations([chat()]);
  restamp({ schema: 1 });

  expect(loadConversations()[0].seq).toBe(7708);
});

it("loses nothing: every other message survives untouched", () => {
  saveConversations([chat()]);
  restamp({ schema: 1 });

  const [back] = loadConversations();
  expect(back.messages).toHaveLength(2);
  expect(back.messages[0]).toMatchObject({ role: "user", blocks: [{ text: "have a look" }] });
  expect(back).toMatchObject({ id: "c1", title: "a chat with a subagent in it", updatedAt: 2 });
});

it("carries forward a row written before there was a stamp at all", () => {
  saveConversations([chat()]);
  restamp({ schema: undefined });

  expect(loadConversations()[0].messages[1].role).toBe("assistant");
});

it("carries forward a chat the server has no record of", () => {
  // No `seq`: the words were built in this browser and exist nowhere else.
  // Redrawing them needs nothing from the server, which is the point.
  saveConversations([{ ...chat(), seq: undefined }]);
  restamp({ schema: 1 });

  const [back] = loadConversations();
  expect(back.messages).toHaveLength(2);
  expect(back.messages[1].role).toBe("assistant");
});
