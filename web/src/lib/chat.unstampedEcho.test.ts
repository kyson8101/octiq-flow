import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, reduceChat, type ChatState, type Message } from "./chat";
import { CatchUp, type Frame } from "./catchUp";
import { saveChatCheckpoint } from "./chatCache";
import { ChatHistory } from "./chatHistory";
import { chatPreviewState, hasLocalPrompt } from "./chatRetention";
import { loadChat, loadEarlierChat } from "./loadChat";
import { replayChat } from "./replayChat";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

const echo = (replay: boolean) => ({ type: "user", uuid: "old-native-echo",
  ...(replay ? { isReplay: true, parent_tool_use_id: null } : {}),
  message: { content: [{ type: "text", text: "continue" }] } });
const prefix: Frame = { seq: 1, event: { type: "system", subtype: "init", session_id: "session" } };
function local(delivery: Message["delivery"] = "sending") {
  const state = addUserTurn(emptyChat(), "continue", [{ path: "/unique.png", name: "unique.png", isImage: true }], 10, "new");
  state.messages[0] = { ...state.messages[0], delivery, queueError: "recovery feedback" };
  return state;
}
function kept(state: ChatState, prompt: Message) {
  const users = state.messages.filter(m => m.role === "user");
  expect(users).toHaveLength(2);
  expect(users.find(m => m.echo === "old-native-echo")?.turnId).toBeUndefined();
  expect(users.find(m => m.turnId === "new")).toEqual(prompt);
  expect(hasLocalPrompt(state)).toBe(true);
  expect(chatPreviewState(state).messages.filter(m => m.role === "user" && !m.echo && !m.takenUp)).toEqual([prompt]);
}

for (const replay of [false, true]) {
  it.each(["cache-prefix", "empty-prefix", "cached-local", "page-context", "earlier", "catch-up"])(
    `does not confirm a new same-text prompt during %s (isReplay=${replay})`, async path => {
      let state = local(); const prompt = state.messages[0];
      const catchUp = new CatchUp(), history = new ChatHistory();
      const options = { id: "a", key: "chat:a", catchUp, history, getState: () => state,
        publish: (next: ChatState) => { state = next; }, cancelled: () => false, request: async () => [] as Frame[] };
      const old = { seq: 2, event: echo(replay) };
      if (["cache-prefix", "empty-prefix", "cached-local"].includes(path)) {
        const cached = path === "cached-local" ? state : path === "empty-prefix" ? emptyChat()
          : await replayChat(emptyChat(), [prefix], 0, () => false);
        await saveChatCheckpoint({ id: "a", seq: 1, updatedAt: 1, state: cached });
        await loadChat({ ...options, request: async after => { expect(after).toBe(1); return [old]; } });
      } else if (path === "page-context") {
        // Empty event pages retain their seed; context must still be historical.
        await loadChat({ ...options, requestPage: async () => ({ events: [], context: [old], before: 3 }) });
      } else if (path === "earlier") {
        await loadChat({ ...options, requestPage: async () => ({ events: [prefix], context: [], before: 1 }) });
        await loadEarlierChat({ ...options, requestPage: async before => before === 1
          ? { events: [], context: [], before: null }
          : { events: [prefix, old], context: [], before: 1 } });
      } else {
        catchUp.own("chat:a");
        catchUp.live("chat:a", 1, prefix.event);
        await loadChat({ ...options, request: async after => { expect(after).toBe(1); return [old]; } });
      }
      kept(state, prompt);
    },
  );

  it.each(["queued", "unknown", "failed"] as const)(`preserves %s recovery through replay (isReplay=${replay})`, async delivery => {
    const state = local(delivery); state.messages[0].queueLost = true; state.messages[0].queueAction = "cancel";
    kept(await replayChat(state, [{ seq: 2, event: echo(replay) }], 0, () => false), state.messages[0]);
  });

  it.each(["sending", "dispatched"] as const)(`keeps the unique dispatching legacy live fallback (%s, isReplay=${replay})`, delivery => {
    const state = reduceChat(local(delivery), echo(replay));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ turnId: "new", echo: "old-native-echo", delivery: "dispatched", attachments: local().messages[0].attachments });
    expect(state.messages[0].queueError).toBeUndefined();
  });

  it.each(["queued", "unknown", "failed"] as const)(`does not guess a legacy live acknowledgement for %s (isReplay=${replay})`, delivery => {
    const state = local(delivery); kept(reduceChat(state, echo(replay)), state.messages[0]);
  });

  it(`does not guess between concurrent dispatches or acknowledge an idle prompt (isReplay=${replay})`, () => {
    const state = local();
    kept(reduceChat({ ...state, busy: false }, echo(replay)), state.messages[0]);
    const concurrent = addUserTurn(state, "different words", [], 11, "second");
    const next = reduceChat(concurrent, echo(replay));
    expect(next.messages).toHaveLength(3);
    expect(next.messages.find(m => m.turnId === "new")).toEqual(state.messages[0]);
  });

  it(`does not count a previously picked-up prompt as a concurrent dispatch (isReplay=${replay})`, () => {
    const old = reduceChat(addUserTurn(emptyChat(), "earlier words", [], 1, "old"), { type: "turn.started", octiq_user_turn_id: "old" });
    const state = reduceChat(addUserTurn(old, "continue", [], 2, "new"), echo(replay));
    expect(state.messages).toHaveLength(2);
    expect(state.messages.find(m => m.turnId === "new")?.echo).toBe("old-native-echo");
  });

  it(`distinguishes buffered legacy live echoes from overlapping historical echoes (isReplay=${replay})`, async () => {
    for (const overlap of [false, true]) {
      let state = local(); const prompt = state.messages[0]; const catchUp = new CatchUp();
      await loadChat({ id: `buffered-${overlap}`, key: "chat:a", catchUp, getState: () => state,
        publish: next => { state = next; }, cancelled: () => false, request: async () => {
          catchUp.live("chat:a", 2, echo(replay));
          return overlap ? [{ seq: 2, event: echo(replay) }] : [];
        } });
      if (overlap) kept(state, prompt);
      else {
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0]).toMatchObject({ turnId: "new", echo: "old-native-echo", delivery: "dispatched" });
      }
    }
  });

  it.each(["echo", "pickup", "cancel"])(`only its own identified %s settles the new prompt after history (isReplay=${replay})`, async evidence => {
    let state = local("unknown"); const prompt = state.messages[0];
    state = await replayChat(state, [{ seq: 2, event: echo(replay) }], 0, () => false);
    kept(state, prompt);
    const own = evidence === "echo" ? { ...echo(replay), uuid: "new-native-echo", octiq_user_turn_id: "new" }
      : evidence === "pickup" ? { type: "turn.started", octiq_user_turn_id: "new" }
      : { type: "octiq_user_turn_cancelled", uuid: "new" };
    state = await replayChat(state, [{ seq: 3, event: own }], 0, () => false);
    expect(hasLocalPrompt(state)).toBe(false);
    expect(state.messages.find(m => m.echo === "old-native-echo")).toBeDefined();
    if (evidence === "cancel") expect(state.messages.find(m => m.turnId === "new")).toBeUndefined();
    else expect(state.messages.find(m => m.turnId === "new")).toMatchObject({ attachments: prompt.attachments,
      ...(evidence === "echo" ? { echo: "new-native-echo" } : { takenUp: true }) });
  });
}
