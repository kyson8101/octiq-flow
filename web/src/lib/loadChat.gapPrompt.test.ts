import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, type ChatState } from "./chat";
import { CatchUp, type Frame } from "./catchUp";
import { saveChatCheckpoint } from "./chatCache";
import { ChatHistory } from "./chatHistory";
import { forgetHiddenScans, loadChat, HIDDEN_PROMPT_PAGES } from "./loadChat";
import { reconcileQueueSnapshot } from "./messageQueue";
import { replayChat } from "./replayChat";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); forgetHiddenScans(); });
afterEach(() => vi.unstubAllGlobals());

// Shaped like the record of chat b6f57a25: the turn's record, its
// "dispatched" delivery line and the Claude echo sit far below the tail the
// page reads on reopen, because the turn then ran for an hour.
const TURN = "user-2e3c0441-1e68-4444-90a5-c5e9ff77aaf0";
const answer = (seq: number): Frame => ({ seq, event: {
  type: "assistant", message: { id: `m${seq}`, content: [{ type: "text", text: `answer ${seq}` }] } } });
const echo = (seq: number): Frame => ({ seq, event: {
  type: "user", uuid: `echo-${seq}`, isReplay: true, octiq_user_turn_id: TURN,
  message: { content: [{ type: "text", text: "开给 CD 一 帧帧 review" }] } } });
const dispatched = (seq: number): Frame => ({ seq, event: { type: "octiq_user_turn_delivery", uuid: TURN, state: "dispatched" } });

function setup() {
  let state: ChatState = emptyChat();
  return { id: "a", key: "chat:a", catchUp: new CatchUp(),
    getState: () => state, publish: (next: ChatState) => { state = next; }, cancelled: () => false };
}

/** A retained tab that sent the prompt, then went offscreen and saw nothing
 * more; the host record moved on by `gap` lines. */
async function retainedTab() {
  const options = setup();
  const seeded = await replayChat(emptyChat(), [answer(1)], 0, () => false);
  await saveChatCheckpoint({ id: "a", seq: 1, state: seeded, updatedAt: 1 });
  const sent = addUserTurn(seeded, "开给 CD 一 帧帧 review", [], 10, TURN);
  options.publish({ ...sent, messages: sent.messages.map(m => m.turnId === TURN ? { ...m, delivery: "queued" as const } : m) });
  return options;
}

/** A host record `total` lines long; each page holds up to 100 lines. */
function host(lines: Record<number, Frame>, total = 1000) {
  const requestPage = vi.fn(async (before: number | null) => {
    const end = before ?? total + 1, start = Math.max(1, end - 100);
    const events: Frame[] = [];
    for (let seq = start; seq < end; seq++) events.push(lines[seq] ?? answer(seq));
    return { events, context: [], before: start > 1 ? start : null };
  });
  return requestPage;
}

const queueGone = { live: false, queuedTurnIds: [] as string[] };

it("does not draw a delivered prompt whose echo is below the reopened window as Not sent", async () => {
  const options = await retainedTab();
  const requestPage = host({ 400: dispatched(400), 401: echo(401) });
  const request = vi.fn(async () => { throw new Error("unbounded tail"); });
  await loadChat({ ...options, history: new ChatHistory(), request, requestPage });
  // The host's own record confirms it, so the bubble is not held in this tab.
  expect(options.getState().messages.find(m => m.turnId === TURN)).toBeUndefined();
  // And no later queue read can condemn it, because it is no longer pending.
  const before = options.getState();
  const after = reconcileQueueSnapshot(before, before, queueGone);
  expect(after.messages.some(m => m.queueLost)).toBe(false);
});

it("keeps the host's own 'failed' for a prompt found below the window", async () => {
  const options = await retainedTab();
  const failed: Frame = { seq: 400, event: { type: "octiq_user_turn_delivery", uuid: TURN, state: "failed" } };
  await loadChat({ ...options, history: new ChatHistory(), request: async () => [], requestPage: host({ 400: failed }) });
  expect(options.getState().messages.find(m => m.turnId === TURN)).toMatchObject({ delivery: "failed", queueLost: true });
});

it("when the scan cannot reach the floor the prompt is unconfirmed, never Not sent", async () => {
  const options = await retainedTab();
  const requestPage = host({ 5: echo(5) }, 100000);
  await loadChat({ ...options, history: new ChatHistory(), request: async () => [], requestPage });
  const pages = requestPage.mock.calls.length;
  expect(pages).toBeLessThanOrEqual(HIDDEN_PROMPT_PAGES + 1);
  const kept = options.getState().messages.find(m => m.turnId === TURN)!;
  expect(kept.delivery).toBe("unknown");
  const after = reconcileQueueSnapshot(options.getState(), options.getState(), queueGone).messages.find(m => m.turnId === TURN)!;
  expect(after.queueLost).toBeUndefined();
  expect(after.delivery).toBe("unknown");
});

it("a prompt the host never got, with the whole gap read, is still Not sent", async () => {
  const options = await retainedTab();
  // The gap is only 150 lines, so the scan reaches the retained mark.
  const requestPage = vi.fn(async (before: number | null) => {
    const end = before ?? 152, start = Math.max(2, end - 100);
    const events: Frame[] = [];
    for (let seq = start; seq < end; seq++) events.push(answer(seq));
    return { events, context: [], before: start > 2 ? start : null };
  });
  await loadChat({ ...options, history: new ChatHistory(), request: async () => [], requestPage });
  const msg = options.getState().messages.find(m => m.turnId === TURN)!;
  expect(msg.delivery).toBe("queued");
  const after = reconcileQueueSnapshot(options.getState(), options.getState(), queueGone).messages.find(m => m.turnId === TURN)!;
  expect(after).toMatchObject({ delivery: "failed", queueLost: true });
});

it("reads nothing extra when no prompt is waiting", async () => {
  const options = setup();
  const seeded = await replayChat(emptyChat(), [answer(1)], 0, () => false);
  await saveChatCheckpoint({ id: "a", seq: 1, state: seeded, updatedAt: 1 });
  const requestPage = host({});
  await loadChat({ ...options, history: new ChatHistory(), request: async () => [], requestPage });
  expect(requestPage).toHaveBeenCalledTimes(1);
});
