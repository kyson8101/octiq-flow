import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, reduceChat, type ChatState } from "./chat";
import { CatchUp, type Frame } from "./catchUp";
import { readChatCheckpoint, saveChatCheckpoint } from "./chatCache";
import { ChatHistory } from "./chatHistory";
import { withLocalPrompts } from "./chatRetention";
import { ABSENCE_ENTRIES, absenceEntries, forgetHiddenScans, HIDDEN_PROMPT_PAGES, loadChat } from "./loadChat";
import { reconcileQueueSnapshot } from "./messageQueue";
import { replayChat } from "./replayChat";
import { deliveryLookupHeld, type TurnDeliveryFact } from "./turnDelivery";

beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); forgetHiddenScans(); });
afterEach(() => vi.unstubAllGlobals());

const TURN = "user-2e3c0441-1e68-4444-90a5-c5e9ff77aaf0";
const answer = (seq: number): Frame => ({ seq, event: {
  type: "assistant", message: { id: `m${seq}`, content: [{ type: "text", text: `answer ${seq}` }] } } });

function setup() {
  let state: ChatState = emptyChat();
  return { id: "a", key: "chat:a", catchUp: new CatchUp(),
    getState: () => state, publish: (next: ChatState) => { state = next; }, cancelled: () => false };
}
type Tab = ReturnType<typeof setup>;

/** A retained tab that sent the prompt as `queued`, then saw nothing more. */
async function retainedTab(delivery: "queued" | "sending" = "queued") {
  const tab = setup();
  const seeded = await replayChat(emptyChat(), [answer(1)], 0, () => false);
  await saveChatCheckpoint({ id: "a", seq: 1, state: seeded, updatedAt: 1 });
  const sent = addUserTurn(seeded, "开给 CD 一 帧帧 review", [], 10, TURN);
  tab.publish({ ...sent, messages: sent.messages.map(m => m.turnId === TURN ? { ...m, delivery } : m) });
  return tab;
}

/** A host record `total` lines long, 100 lines a page. */
function host(total = 1000) {
  return vi.fn(async (before: number | null) => {
    const end = before ?? total + 1, start = Math.max(1, end - 100);
    const events: Frame[] = [];
    for (let seq = start; seq < end; seq++) events.push(answer(seq));
    return { events, context: [], before: start > 1 ? start : null };
  });
}

/** The host's answer: one fact per asked id (anything unlisted is absent). */
const asking = (facts: Record<string, TurnDeliveryFact>) => vi.fn(async (ids: string[]) => ({
  turns: Object.fromEntries(ids.map(id => [id, facts[id] ?? { state: "absent" }])) }));

const opts = (tab: Tab, requestPage: unknown, requestDelivery?: unknown) => ({
  ...tab, history: new ChatHistory(), request: async () => [], requestPage, requestDelivery } as Parameters<typeof loadChat>[0]);
const msg = (tab: Tab, id = TURN) => tab.getState().messages.find(m => m.turnId === id);
const queueGone = { live: false, queuedTurnIds: [] as string[] };
const poll = (tab: Tab, queue = queueGone) => { const s = tab.getState(); tab.publish(reconcileQueueSnapshot(s, s, queue)); };

describe("chat_turn_delivery lookup", () => {
  it("asks once, with every pending id, before reading any older page", async () => {
    const tab = await retainedTab();
    const pages = host(); const ask = asking({ [TURN]: { state: "queued" } });
    await loadChat(opts(tab, pages, ask));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith([TURN]);
    expect(pages).toHaveBeenCalledTimes(1); // the recent page only, no 40-page scan
  });

  it.each(["accepted", "cancelled", "dismissed"] as const)("%s drops the local copy", async state => {
    const tab = await retainedTab();
    await loadChat(opts(tab, host(), asking({ [TURN]: { state, seq: 400 } })));
    expect(msg(tab)).toBeUndefined();
    poll(tab); // and nothing is left for the queue poll to call unsent
    expect(msg(tab)).toBeUndefined();
  });

  it("failed keeps the prompt as Not sent with Restore, as a host failure", async () => {
    const tab = await retainedTab();
    await loadChat(opts(tab, host(), asking({ [TURN]: { state: "failed", seq: 400 } })));
    expect(msg(tab)).toMatchObject({ delivery: "failed", queueLost: true, hostFailed: true });
  });

  it("queued keeps it queued", async () => {
    const tab = await retainedTab("sending");
    await loadChat(opts(tab, host(), asking({ [TURN]: { state: "queued" } })));
    expect(msg(tab)).toMatchObject({ delivery: "queued", queueLost: undefined, hostFailed: undefined });
  });

  it("dispatched shows the dispatched delivery, never failed", async () => {
    const tab = await retainedTab();
    await loadChat(opts(tab, host(), asking({ [TURN]: { state: "dispatched", seq: 400 } })));
    expect(msg(tab)).toMatchObject({ delivery: "dispatched", queueLost: undefined, hostFailed: undefined });
    poll(tab); // idle queue poll: not in the queue, not live
    expect(msg(tab)?.delivery).not.toBe("failed");
    expect(msg(tab)?.queueLost).toBeUndefined();
  });

  it("absent changes nothing, reads nothing more, and caches no absence", async () => {
    const tab = await retainedTab();
    const pages = host();
    await loadChat(opts(tab, pages, asking({})));
    expect(msg(tab)).toMatchObject({ delivery: "queued" });
    expect(pages).toHaveBeenCalledTimes(1);
    expect(absenceEntries()).toBe(0);
    // a prompt sent this instant whose envelope is not on disk yet stays pending
    // and unconfirmed; only the queue can still turn it, exactly as before
    const fresh = await retainedTab("sending");
    await loadChat(opts(fresh, host(), asking({})));
    expect(msg(fresh)).toMatchObject({ delivery: "sending" });
  });

  it("a failed line older than a later dispatch loses: the newest seq wins across merged ids", async () => {
    const tab = await retainedTab();
    tab.publish(addUserTurn(tab.getState(), "append", [], 11, "source"));
    tab.publish(reduceChat(tab.getState(), { type: "octiq_user_turn_appended", uuid: TURN, appended_uuid: "source" }));
    const ask = asking({ [TURN]: { state: "failed", seq: 300 }, source: { state: "dispatched", seq: 800, into: TURN } });
    await loadChat(opts(tab, host(), ask));
    expect(ask).toHaveBeenCalledWith([TURN, "source"]);
    expect(msg(tab)).toMatchObject({ delivery: "dispatched", hostFailed: undefined, queueLost: undefined });
  });

  it("into: the state applies to the local message that owns the asked id", async () => {
    const tab = await retainedTab();
    tab.publish(addUserTurn(tab.getState(), "append", [], 11, "source"));
    tab.publish(reduceChat(tab.getState(), { type: "octiq_user_turn_appended", uuid: TURN, appended_uuid: "source" }));
    // the host folded the source into the target, which the agent then took up
    await loadChat(opts(tab, host(), asking({ source: { state: "accepted", seq: 500, into: TURN }, [TURN]: { state: "accepted", seq: 500 } })));
    expect(msg(tab)).toBeUndefined();
    expect(msg(tab, "source")).toBeUndefined();
    // only the source is merged and accepted; its own message is the one that goes
    const other = await retainedTab();
    other.publish(addUserTurn(other.getState(), "second", [], 12, "second"));
    await loadChat(opts(other, host(), asking({ second: { state: "accepted", seq: 600, into: "elsewhere" } })));
    expect(msg(other, "second")).toBeUndefined();
    expect(msg(other)).toMatchObject({ delivery: "queued" });
  });

  it("ids go in batches of at most 32", async () => {
    const tab = await retainedTab();
    for (let i = 0; i < 39; i++) tab.publish(addUserTurn(tab.getState(), `m${i}`, [], 20 + i, `many-${i}`));
    const ask = asking({});
    await loadChat(opts(tab, host(), ask));
    expect(ask.mock.calls.map(([ids]) => ids.length)).toEqual([32, 8]);
  });

  it("a chat with no pending local prompt asks nothing", async () => {
    const tab = setup();
    const seeded = await replayChat(emptyChat(), [answer(1)], 0, () => false);
    tab.publish(seeded);
    await saveChatCheckpoint({ id: "a", seq: 1, state: seeded, updatedAt: 1 });
    const ask = asking({}); const pages = host();
    await loadChat(opts(tab, pages, ask));
    expect(ask).not.toHaveBeenCalled();
    expect(pages).toHaveBeenCalledTimes(1);
  });

  describe("when the host cannot say", () => {
    const refusals: [string, (ids: string[]) => Promise<unknown>][] = [
      ["an older backend", async () => { throw new Error("'chat_turn_delivery' is not available on this backend"); }],
      ["a network error", async () => { throw new Error("socket closed"); }],
      ["an answer that is not one", async () => "nope"],
      ["an answer that leaves an id out", async () => ({ turns: {} })],
    ];
    it.each(refusals)("%s falls back to the page scan, never to Not sent", async (_name, ask) => {
      const tab = await retainedTab();
      const pages = host(100000);
      await loadChat(opts(tab, pages, vi.fn(ask)));
      expect(pages).toHaveBeenCalledTimes(HIDDEN_PROMPT_PAGES + 1);
      expect(msg(tab)).toMatchObject({ delivery: "unknown", queueLost: undefined });
    });
    it("no requestDelivery at all is the same scan", async () => {
      const tab = await retainedTab();
      const pages = host(100000);
      await loadChat(opts(tab, pages));
      expect(pages).toHaveBeenCalledTimes(HIDDEN_PROMPT_PAGES + 1);
      expect(msg(tab)).toMatchObject({ delivery: "unknown" });
    });
    it("the scan still finds an echo when the lookup is unavailable", async () => {
      const tab = await retainedTab();
      const echo: Frame = { seq: 400, event: { type: "user", uuid: "echo-400", isReplay: true, octiq_user_turn_id: TURN,
        message: { content: [{ type: "text", text: "x" }] } } };
      const pages = vi.fn(async (before: number | null) => {
        const end = before ?? 1001, start = Math.max(1, end - 100);
        const events: Frame[] = [];
        for (let seq = start; seq < end; seq++) events.push(seq === 400 ? echo : answer(seq));
        return { events, context: [], before: start > 1 ? start : null };
      });
      await loadChat(opts(tab, pages, async () => { throw new Error("not available on this backend"); }));
      expect(msg(tab)).toBeUndefined();
    });
  });

  describe("the idle queue poll while the host is being asked", () => {
    it("cannot turn the prompt into Not sent, before or after the answer", async () => {
      const tab = await retainedTab();
      let answerNow!: (value: unknown) => void;
      const ask = vi.fn(() => new Promise<unknown>(resolve => { answerNow = resolve; }));
      const loading = loadChat(opts(tab, host(), ask));
      await vi.waitFor(() => expect(ask).toHaveBeenCalled());
      expect(deliveryLookupHeld(msg(tab)!)).toBe(true);
      // the poll runs with the request held: no queue entry, not live
      poll(tab);
      expect(msg(tab)?.delivery).toBe("queued");
      expect(msg(tab)?.queueLost).toBeUndefined();
      poll(tab, { live: true, queuedTurnIds: [] });
      expect(msg(tab)?.delivery).toBe("queued");
      answerNow({ turns: { [TURN]: { state: "dispatched", seq: 800 } } });
      await loading;
      expect(deliveryLookupHeld(msg(tab)!)).toBe(false);
      expect(msg(tab)).toMatchObject({ delivery: "dispatched" });
      poll(tab);
      expect(msg(tab)?.delivery).not.toBe("failed");
    });

    it("is released when the lookup fails, and then queue absence works as it did", async () => {
      const tab = await retainedTab();
      let fail!: (e: unknown) => void;
      const ask = vi.fn(() => new Promise<unknown>((_, reject) => { fail = reject; }));
      const loading = loadChat(opts(tab, host(100000), ask));
      await vi.waitFor(() => expect(ask).toHaveBeenCalled());
      poll(tab);
      expect(msg(tab)?.delivery).toBe("queued");
      fail(new Error("socket closed"));
      await loading;
      expect(deliveryLookupHeld(msg(tab)!)).toBe(false);
    });

    it("control: without a lookup in flight the poll still says Not sent for a prompt that is really gone", async () => {
      const tab = await retainedTab();
      poll(tab);
      expect(msg(tab)).toMatchObject({ delivery: "failed", queueLost: true });
    });

    it("a cancelled load releases the hold", async () => {
      const tab = await retainedTab();
      let stop = false;
      let answerNow!: (value: unknown) => void;
      const ask = vi.fn(() => new Promise<unknown>(resolve => { answerNow = resolve; }));
      const loading = loadChat({ ...opts(tab, host(), ask), cancelled: () => stop });
      await vi.waitFor(() => expect(ask).toHaveBeenCalled());
      stop = true;
      answerNow({ turns: { [TURN]: { state: "queued" } } });
      await loading;
      expect(deliveryLookupHeld(msg(tab)!)).toBe(false);
    });
  });
});

describe("M1: an older local copy does not overwrite newer host provenance", () => {
  it("keeps the local words and identity but the checkpoint's host failure", () => {
    const base = addUserTurn(emptyChat(), "saved words", [], 1, TURN);
    const saved = reduceChat(base, { type: "octiq_user_turn_delivery", uuid: TURN, state: "failed" });
    const typed = addUserTurn(emptyChat(), "typed words", [], 1, TURN);
    const local = { ...typed, messages: typed.messages.map(m => ({ ...m, id: "local-1", delivery: "queued" as const })) };
    const merged = withLocalPrompts(saved, local, true).messages.find(m => m.turnId === TURN)!;
    expect(merged).toMatchObject({ id: "local-1", delivery: "failed", queueLost: true, hostFailed: true });
    expect(merged.blocks).toEqual(local.messages[0].blocks);
  });

  it("keeps a checkpoint's dispatch over a local queued copy, and a local host failure over both", () => {
    const base = addUserTurn(emptyChat(), "w", [], 1, TURN);
    const savedDispatched = reduceChat(base, { type: "octiq_user_turn_delivery", uuid: TURN, state: "dispatched" });
    const queuedLocal = { ...base, messages: base.messages.map(m => ({ ...m, delivery: "queued" as const })) };
    expect(withLocalPrompts(savedDispatched, queuedLocal, true).messages[0].delivery).toBe("dispatched");
    const failedLocal = reduceChat(queuedLocal, { type: "octiq_user_turn_delivery", uuid: TURN, state: "failed" });
    expect(withLocalPrompts(savedDispatched, failedLocal, true).messages[0]).toMatchObject({ delivery: "failed", hostFailed: true });
  });

  it("the first publication of a reopened chat carries the checkpoint's host failure; the lookup then settles it", async () => {
    const tab = await retainedTab();
    const authoritative = reduceChat(tab.getState(), { type: "octiq_user_turn_delivery", uuid: TURN, state: "failed" });
    await saveChatCheckpoint({ id: "a", seq: 2, state: authoritative, updatedAt: 2 });
    const phases: (ReturnType<typeof msg>)[] = [];
    const publish = (s: ChatState) => { phases.push(s.messages.find(m => m.turnId === TURN)); tab.publish(s); };
    await loadChat({ ...opts(tab, host(), asking({ [TURN]: { state: "dispatched", seq: 900 } })), publish });
    expect(phases[0]).toMatchObject({ hostFailed: true, delivery: "failed" });
    // the host says the failure was followed by a dispatch: the newest fact wins
    expect(msg(tab)).toMatchObject({ delivery: "dispatched", hostFailed: undefined, queueLost: undefined });
  });
});

describe("M2: the absence cache is bounded", () => {
  const recentThenOne = () => vi.fn(async (before: number | null) => before === null
    ? { events: [answer(1000)], context: [], before: 900 }
    : { events: [answer(899)], context: [], before: null });

  it("stays within its cap across many unique prompts", async () => {
    const tab = setup(); const pages = recentThenOne();
    for (let i = 0; i < ABSENCE_ENTRIES + 72; i++) {
      tab.catchUp.forget(tab.key);
      tab.publish(addUserTurn(emptyChat(), "local", [], i, `absent-${i}`));
      await loadChat(opts(tab, pages));
      tab.publish(reduceChat(tab.getState(), { type: "octiq_user_turn_dismissed", uuid: `absent-${i}` }));
    }
    expect(absenceEntries()).toBeLessThanOrEqual(ABSENCE_ENTRIES);
  });

  it("stays within its cap when that many prompts are all still pending", async () => {
    const tab = setup(); const pages = recentThenOne();
    let state = emptyChat();
    for (let i = 0; i < ABSENCE_ENTRIES + 40; i++) state = addUserTurn(state, `p${i}`, [], i, `pending-${i}`);
    tab.publish(state);
    await loadChat(opts(tab, pages));
    expect(absenceEntries()).toBe(ABSENCE_ENTRIES);
  });

  it("a dismissed prompt's entry is gone the next time its chat loads", async () => {
    const tab = setup(); const pages = recentThenOne();
    tab.publish(addUserTurn(emptyChat(), "local", [], 1, "one"));
    await loadChat(opts(tab, pages));
    expect(absenceEntries()).toBe(1);
    tab.publish(reduceChat(tab.getState(), { type: "octiq_user_turn_dismissed", uuid: "one" }));
    tab.catchUp.forget(tab.key);
    await loadChat(opts(tab, pages));
    expect(absenceEntries()).toBe(0);
  });

  it("forgetting one chat leaves another's entries; dropping an entry only means a re-read", async () => {
    const a = setup(); const pages = recentThenOne();
    a.publish(addUserTurn(emptyChat(), "local", [], 1, "one"));
    await loadChat(opts(a, pages));
    const b = { ...setup(), id: "b", key: "chat:b" };
    b.publish(addUserTurn(emptyChat(), "local", [], 1, "two"));
    await loadChat(opts(b, pages));
    expect(absenceEntries()).toBe(2);
    forgetHiddenScans("chat:a");
    expect(absenceEntries()).toBe(1);
    const reads = pages.mock.calls.length;
    a.catchUp.forget(a.key);
    await loadChat(opts(a, pages));
    expect(pages.mock.calls.length).toBeGreaterThan(reads + 1); // read again, safely
  });
});

describe("L1: an echo or pickup clears hostFailed", () => {
  const failedTab = async () => {
    const tab = await retainedTab();
    tab.publish(reduceChat(tab.getState(), { type: "octiq_user_turn_delivery", uuid: TURN, state: "failed" }));
    expect(msg(tab)).toMatchObject({ hostFailed: true });
    return tab;
  };
  it("a live echo", async () => {
    const tab = await failedTab();
    tab.publish(reduceChat(tab.getState(), { type: "user", uuid: "echo-3", isReplay: true, octiq_user_turn_id: TURN,
      message: { content: [{ type: "text", text: "x" }] } }));
    expect(msg(tab)).toMatchObject({ echo: "echo-3", delivery: "dispatched", queueLost: undefined, hostFailed: undefined });
  });
  it("a Codex turn.started", async () => {
    const tab = await failedTab();
    tab.publish(reduceChat(tab.getState(), { type: "turn.started", octiq_user_turn_id: TURN }));
    expect(msg(tab)).toMatchObject({ takenUp: true, delivery: "dispatched", queueLost: undefined, hostFailed: undefined });
  });
  it("a window replay that adopts the echo", () => {
    const failed = reduceChat(addUserTurn(emptyChat(), "w", [], 1, TURN), { type: "octiq_user_turn_delivery", uuid: TURN, state: "failed" });
    const echoed = reduceChat(addUserTurn(emptyChat(), "w", [], 1, TURN), { type: "user", uuid: "e", isReplay: true, octiq_user_turn_id: TURN,
      message: { content: [{ type: "text", text: "w" }] } });
    expect(echoed.messages[0].echo).toBe("e");
    const next = withLocalPrompts(echoed, failed);
    const adopted = next.messages.find(m => m.turnId === TURN)!;
    expect(adopted.delivery).toBe("dispatched");
    expect(adopted.queueLost).toBeUndefined();
    expect(adopted.hostFailed).toBeUndefined();
  });
  it("survives the checkpoint round trip as cleared", async () => {
    const tab = await failedTab();
    tab.publish(reduceChat(tab.getState(), { type: "turn.started", octiq_user_turn_id: TURN }));
    await saveChatCheckpoint({ id: "a", seq: 5, state: tab.getState(), updatedAt: 5 });
    expect((await readChatCheckpoint("a"))?.state.messages.find(m => m.turnId === TURN)?.hostFailed).toBeUndefined();
  });
});
