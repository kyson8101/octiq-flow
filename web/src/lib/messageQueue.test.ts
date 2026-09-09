import { describe, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, reduceChat, type ChatState } from "./chat";
import { MessageQueueActions, reconcileQueueSnapshot, reclaimedMessage } from "./messageQueue";

const queued = () => reduceChat(addUserTurn(emptyChat(), "next", [], 1, undefined, "turn"), {
  type: "octiq_user_turn_delivery", uuid: "turn", state: "queued",
});
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function harness(initial = queued()) {
  let state = initial;
  const call = deferred();
  const reclaim = vi.fn();
  const options = {
    chatId: "chat", turnId: "turn", action: "start" as const,
    read: () => state,
    patch: (change: (s: ChatState) => ChatState) => { state = change(state); },
    invoke: vi.fn(() => call.promise),
    refresh: vi.fn(async () => {
      state = reconcileQueueSnapshot(state, state, { live: true, queuedTurnIds: [] });
    }),
    reclaim,
  };
  return { options, call, reclaim };
}

describe("queue operations", () => {
  it("allows only one start or edit while a response is delayed", async () => {
    const queue = new MessageQueueActions();
    const { options, call } = harness();
    const first = queue.run(options);
    expect(options.read().messages[0].queueAction).toBe("start");
    await queue.run({ ...options, action: "cancel" });
    await queue.run(options);
    expect(options.invoke).toHaveBeenCalledTimes(1);
    call.resolve(false);
    await first;
    expect(options.read().messages[0]).toMatchObject({ delivery: "unknown" });
    expect(options.read().notices).toEqual([]);
    await queue.run(options);
    expect(options.invoke).toHaveBeenCalledTimes(1);
  });

  it("restores the original message after the cancellation broadcast arrived first", async () => {
    const queue = new MessageQueueActions();
    const { options, call, reclaim } = harness();
    const original = options.read().messages[0];
    original.attachments = [{ path: "/tmp/image.png", name: "image.png", isImage: true }];
    const action = queue.run({ ...options, action: "cancel" });
    options.patch((s) => reduceChat(s, { type: "octiq_user_turn_cancelled", uuid: "turn" }));
    call.resolve(true);
    await action;
    expect(reclaim).toHaveBeenCalledExactlyOnceWith(original);
    expect(options.read().messages).toEqual([]);
  });

  it("reconciles a lost RPC response and keeps the error on the message", async () => {
    const { options } = harness();
    await new MessageQueueActions().run({ ...options, invoke: async () => { throw new Error("Connection closed"); } });
    expect(options.refresh).toHaveBeenCalledTimes(1);
    expect(options.read().messages[0]).toMatchObject({ delivery: "unknown", queueError: "Connection closed" });
    expect(options.read().messages[0].queueAction).toBeUndefined();
    expect(options.read().notices).toEqual([]);
  });

  it("ignores sending and already dispatched prompts", async () => {
    for (const delivery of ["sending", "dispatched", "starting"] as const) {
      const state = queued(); state.messages[0].delivery = delivery;
      const { options } = harness(state);
      await new MessageQueueActions().run(options);
      expect(options.invoke).not.toHaveBeenCalled();
    }
  });
});

describe("queue snapshots", () => {
  it("updates an unchanged prompt even when another answer streamed", () => {
    const before = queued();
    const current = { ...before, messages: [...before.messages, { id: "answer", role: "assistant" as const, streaming: true, blocks: [] }] };
    const next = reconcileQueueSnapshot(current, before, { live: true, queuedTurnIds: [] });
    expect(next.messages[0].delivery).toBe("unknown");
    expect(next.messages[1]).toBe(current.messages[1]);
  });
  it("does not overwrite a newer exact delivery event with a stale snapshot", () => {
    const before = queued();
    const current = reduceChat(before, { type: "octiq_user_turn_delivery", uuid: "turn", state: "dispatched" });
    const next = reconcileQueueSnapshot(current, before, { live: false, queuedTurnIds: [] });
    expect(next.messages[0].delivery).toBe("dispatched");
  });
});

describe("provider-independent delivery", () => {
  it("does not mark a dispatched Codex prompt as provider-acknowledged", () => {
    const state = reduceChat(queued(), { type: "octiq_user_turn_delivery", uuid: "turn", state: "dispatched" });
    expect(state.messages[0].takenUp).toBeUndefined();
    expect(state.messages[0].delivery).toBe("dispatched");
  });
  it("claims the exact Claude echo when identical text is queued twice", () => {
    let state = addUserTurn(queued(), "next", [], 2, undefined, "second");
    state = reduceChat(state, { type: "user", uuid: "echo-second", octiq_user_turn_id: "second", message: { content: [{ type: "text", text: "next" }] } });
    expect(state.messages[0].echo).toBeUndefined();
    expect(state.messages[1].echo).toBe("echo-second");
  });
  it("replays a durable Claude queue and native echo as one message", () => {
    let state = reduceChat(emptyChat(), { type: "user", uuid: "turn", octiq_user_turn: true, message: { content: [{ type: "text", text: "next" }] } });
    state = reduceChat(state, { type: "octiq_user_turn_delivery", uuid: "turn", state: "dispatched" });
    state = reduceChat(state, { type: "user", uuid: "echo", octiq_user_turn_id: "turn", message: { content: [{ type: "text", text: "next" }] } });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ turnId: "turn", echo: "echo" });
  });
});


describe("restoring a message", () => {
  it("restores attachment paths and seat routing without repeating file instructions", () => {
    const state = queued();
    const message = { ...state.messages[0], to: { id: "seat", name: "Dee" },
      blocks: [{ kind: "text" as const, text: "Review this\n\nFiles to look at:\n- /tmp/spec.md" }],
      attachments: [{ path: "/tmp/spec.md", name: "spec.md", isImage: false }, { path: "/tmp/shot.png", name: "shot.png", isImage: true }],
    };
    expect(reclaimedMessage(message)).toEqual({ text: "@Dee Review this", attachments: message.attachments });
  });
  it("clears a checkpoint's obsolete action lock while keeping live operations locked", () => {
    const state = queued(); state.messages[0].queueAction = "start";
    const snapshot = { live: true, queuedTurnIds: ["turn"] };
    expect(reconcileQueueSnapshot(state, state, snapshot).messages[0].queueAction).toBeUndefined();
    expect(reconcileQueueSnapshot(state, state, snapshot, () => true).messages[0].queueAction).toBe("start");
  });
});


it("never reuses a remaining bubble's identity after editing an earlier queued message", () => {
  let state = addUserTurn(queued(), "second", [], 2, undefined, "second");
  state = reduceChat(state, { type: "octiq_user_turn_cancelled", uuid: "turn" });
  state = addUserTurn(state, "third", [], 3, undefined, "third");
  expect(new Set(state.messages.map((m) => m.id)).size).toBe(2);
  expect(state.messages.map((m) => m.turnId)).toEqual(["second", "third"]);
});
