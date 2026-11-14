import { describe, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, type ChatState } from "./chat";
import { dismissUnsentTurn, NOT_DISMISSED } from "./dismissUnsent";
import { readDeliveryAnswer, type TurnDeliveryFact } from "./turnDelivery";

const TURN = "user-aaaa";

/** A tab whose bubble reads "Not sent" (queueLost). */
function tab() {
  const sent = addUserTurn(emptyChat(), "hello", [], 10, TURN);
  let state: ChatState = { ...sent, messages: sent.messages.map(m => ({ ...m, delivery: "failed" as const, queueLost: true })) };
  return {
    read: () => state,
    patch: (update: (s: ChatState) => ChatState) => { state = update(state); },
    msg: () => state.messages.find(m => m.turnId === TURN),
    get state() { return state; },
  };
}
const answering = (fact: TurnDeliveryFact) => vi.fn(async (ids: string[]) => ({ turns: Object.fromEntries(ids.map(id => [id, fact])) }));

describe("dismissing a Not sent bubble", () => {
  it("true: the bubble goes and the host is not asked again", async () => {
    const t = tab(); const lookup = answering({ state: "accepted" });
    await dismissUnsentTurn({ turnId: TURN, read: t.read, patch: t.patch, dismiss: async () => true, lookup });
    expect(t.msg()).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("false then the lookup says accepted: the bubble goes", async () => {
    const t = tab(); const lookup = answering({ state: "accepted", seq: 9 });
    await dismissUnsentTurn({ turnId: TURN, read: t.read, patch: t.patch, dismiss: async () => false, lookup });
    expect(lookup).toHaveBeenCalledWith([TURN]);
    expect(t.msg()).toBeUndefined();
    expect(t.state.notices).toEqual([]);
  });

  it("false then the lookup says queued: the bubble is queued, not Not sent", async () => {
    const t = tab();
    await dismissUnsentTurn({ turnId: TURN, read: t.read, patch: t.patch, dismiss: async () => false, lookup: answering({ state: "queued" }) });
    expect(t.msg()?.delivery).toBe("queued");
    expect(t.msg()?.queueLost).toBeUndefined();
  });

  it("false and no lookup on this host: the bubble stays with one quiet line", async () => {
    const t = tab();
    await dismissUnsentTurn({ turnId: TURN, read: t.read, patch: t.patch, dismiss: async () => false });
    expect(t.msg()?.queueLost).toBe(true);
    expect(t.state.notices).toHaveLength(1);
    expect(t.state.notices[0]).toContain(NOT_DISMISSED);
  });

  it("false and the lookup errors, answers nonsense or leaves the id out: stays, one line each time", async () => {
    for (const lookup of [
      vi.fn(async () => { throw new Error("'chat_turn_delivery' is not available on this backend"); }),
      vi.fn(async () => "nope"),
      vi.fn(async () => ({ turns: {} })),
    ]) {
      const t = tab();
      await dismissUnsentTurn({ turnId: TURN, read: t.read, patch: t.patch, dismiss: async () => false, lookup });
      expect(t.msg()?.queueLost).toBe(true);
      expect(t.state.notices).toHaveLength(1);
      expect(t.state.notices[0]).toContain(NOT_DISMISSED);
    }
  });

  it("false and the host holds no record: stays with the line", async () => {
    const t = tab();
    await dismissUnsentTurn({ turnId: TURN, read: t.read, patch: t.patch, dismiss: async () => false, lookup: answering({ state: "absent" }) });
    expect(t.msg()?.queueLost).toBe(true);
    expect(t.state.notices[0]).toContain(NOT_DISMISSED);
  });

  it("a dismiss that errors keeps the existing notice and asks nothing", async () => {
    const t = tab(); const lookup = answering({ state: "accepted" });
    await dismissUnsentTurn({ turnId: TURN, read: t.read, patch: t.patch, dismiss: async () => { throw new Error("boom"); }, lookup });
    expect(t.state.notices).toEqual(["boom"]);
    expect(lookup).not.toHaveBeenCalled();
    expect(t.msg()).toBeDefined();
  });

  it("a message that owns several ids is folded: accepted on any id wins over a later failed one", async () => {
    const sent = addUserTurn(emptyChat(), "hello", [], 10, TURN);
    let state: ChatState = { ...sent, messages: sent.messages.map(m => ({ ...m, sourceTurnIds: ["user-bbbb"], delivery: "failed" as const, queueLost: true })) };
    const lookup = vi.fn(async () => ({ turns: {
      [TURN]: { state: "failed", seq: 20 }, "user-bbbb": { state: "accepted", seq: 5, into: TURN } } }));
    await dismissUnsentTurn({ turnId: TURN, read: () => state, patch: u => { state = u(state); }, dismiss: async () => false, lookup });
    expect(state.messages.find(m => m.turnId === TURN)).toBeUndefined();
    expect(readDeliveryAnswer({ turns: { x: { state: "accepted", seq: 1 } } }).get("x")?.state).toBe("accepted");
  });
});
