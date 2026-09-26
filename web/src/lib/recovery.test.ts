import { describe, expect, it } from "vitest";
import {
  provesLiveTurn,
  queuedMessageCount,
  reconcileUnsentMessages,
} from "./recovery";
import { addUserTurn, emptyChat, reduceChat } from "./chat";

describe("live turn evidence", () => {
  it("recognises backend-started Codex and Claude turns", () => {
    expect(provesLiveTurn({ type: "turn.started" })).toBe(true);
    expect(provesLiveTurn({ type: "stream_event", event: { type: "message_start" } })).toBe(true);
  });

  it("does not mistake durable queue envelopes or completed turns for a live worker", () => {
    expect(provesLiveTurn({ type: "user", octiq_user_turn: true })).toBe(false);
    expect(provesLiveTurn({ type: "octiq_user_turn_delivery", state: "dispatched" })).toBe(false);
    expect(provesLiveTurn({ type: "turn.completed" })).toBe(false);
  });
});

describe("current queued messages", () => {
  const user = (id: string, extra: Partial<import("./chat").Message> = {}): import("./chat").Message => ({ id, role: "user", streaming: false, blocks: [], ...extra });
  const answer: import("./chat").Message = { id: "answer", role: "assistant", streaming: false, blocks: [] };
  it("counts current canonical prompts after an answer without counting old legacy users", () => {
    expect(queuedMessageCount({ messages: [user("old"), answer, user("first", { turnId: "one" }), user("second", { turnId: "two" })] })).toBe(2);
  });
  it("excludes accepted turns signaled by echo or takenUp", () => {
    expect(queuedMessageCount({ messages: [user("accepted", { turnId: "one", takenUp: true }), user("next", { turnId: "two" })] })).toBe(1);
    expect(queuedMessageCount({ messages: [user("accepted", { turnId: "one", echo: "uuid" })] })).toBe(0);
    expect(queuedMessageCount({ messages: [user("accepted", { takenUp: true }), answer] })).toBe(0);
  });
  it("leaves unknown legacy and seat queues unspecified", () => {
    expect(queuedMessageCount({ messages: [user("legacy"), answer] })).toBeUndefined();
    expect(queuedMessageCount({ messages: [user("legacy")] })).toBeUndefined();
    expect(queuedMessageCount({ messages: [user("seat", { turnId: "one", to: { id: "s", name: "Seat" } })] })).toBeUndefined();
  });
});

describe("messages left behind after queue loss", () => {
  const pending = () => ({ ...addUserTurn(emptyChat(), "status?", [], 1, "old-status"), busy: false });
  const gone = { live: false, queuedTurnIds: [] };

  it("keeps an unacknowledged message but stops claiming it is queued", () => {
    const state = reconcileUnsentMessages(pending(), gone);
    expect(state.messages[0]).toMatchObject({ turnId: "old-status", queueLost: true });
    expect(state.messages[0].takenUp).toBeUndefined();
    expect(queuedMessageCount(state)).toBe(0);
    expect(reconcileUnsentMessages(state, gone)).toBe(state);
  });

  it("reconciles during a live response without inventing acknowledgement", () => {
    const state = pending();
    expect(reconcileUnsentMessages(state, { ...gone, live: true }).messages[0]).toMatchObject({ delivery: "unknown" });
    expect(reconcileUnsentMessages(state, { ...gone, queuedTurnIds: ["old-status"] }).messages[0]).toMatchObject({ delivery: "queued" });
    expect(reconcileUnsentMessages({ ...state, busy: true }, gone).messages[0]).toMatchObject({ delivery: "failed" });
  });

  it("does not turn a handed-over message back into a queue failure", () => {
    const state = pending();
    state.messages[0].delivery = "dispatched";
    expect(reconcileUnsentMessages(state, gone).messages[0]).toMatchObject({ delivery: "unknown" });
    expect(reconcileUnsentMessages(state, { ...gone, live: true })).toBe(state);
  });

  it("does not move the old message under new replies or claim it as a new prompt", () => {
    let state = reconcileUnsentMessages(pending(), gone);
    state = addUserTurn(state, "new task", [], 2, "new-task");
    state = reduceChat(state, { type: "turn.started" });
    expect(state.messages.map(m => [m.turnId, !!m.takenUp])).toEqual([["old-status", false], ["new-task", true]]);
    state = reduceChat(state, { type: "item.completed", item: { id: "answer", type: "agent_message", text: "New reply" } });
    expect(state.messages.at(-1)?.role).toBe("assistant");
    expect(state.messages[0].queueLost).toBe(true);
  });

  it("lets a later exact acknowledgement correct the earlier snapshot", () => {
    const state = reduceChat(reconcileUnsentMessages(pending(), gone), {
      type: "turn.started", octiq_user_turn_id: "old-status",
    });
    expect(state.messages[0].takenUp).toBe(true);
    expect(state.messages[0].queueLost).toBeUndefined();
  });
});

it("reconciles a combined queue unit from any source id", () => {
  let state = addUserTurn(emptyChat(), "first", [], 1, "user-1");
  state.messages[0].sourceTurnIds = ["user-1", "user-2"];
  const next = reconcileUnsentMessages(state, { live: true, queuedTurnIds: ["user-2"] });
  expect(next.messages[0]).toMatchObject({ delivery: "queued", queueLost: undefined });
});
