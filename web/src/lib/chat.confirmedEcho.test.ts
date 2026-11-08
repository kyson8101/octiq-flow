import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it } from "vitest";
import { addUserTurn, emptyChat, reduceChat, type ChatState } from "./chat";
import { CatchUp, type Frame } from "./catchUp";
import { saveChatCheckpoint } from "./chatCache";
import { ChatHistory } from "./chatHistory";
import { chatPreviewState, hasLocalPrompt, withLocalPrompts } from "./chatRetention";
import { loadChat, loadEarlierChat } from "./loadChat";
import { reconcileQueueSnapshot } from "./messageQueue";
import { replayChat } from "./replayChat";
import commandEcho from "./__fixtures__/command-echo.jsonl?raw";

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
afterEach(() => { delete (globalThis as { indexedDB?: IDBFactory }).indexedDB; });

const attachments = [{ path: "/fixture/image.png", name: "image.png", isImage: true }];
const echo = (turnId = "local", text = "continue", uuid = "claude-native-echo") => ({
  type: "user", isReplay: true, parent_tool_use_id: null, uuid,
  octiq_user_turn_id: turnId, message: { content: [{ type: "text", text }] },
});
const stamped = (seq = 1): Frame => ({ seq, event: echo() });
function pending() {
  const state = addUserTurn(emptyChat(), "continue", attachments, 10, "local");
  state.messages[0] = { ...state.messages[0], delivery: "unknown", queueLost: true,
    queueAction: "cancel", queueError: "stale queue feedback" };
  return state;
}
function confirmed(state: ChatState) {
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]).toMatchObject({ id: "u:local", turnId: "local",
    echo: "claude-native-echo", delivery: "dispatched", attachments });
  expect(state.messages[0].blocks).toEqual(pending().messages[0].blocks);
  expect(state.messages[0].queueLost).toBeUndefined();
  expect(state.messages[0].queueAction).toBeUndefined();
  expect(state.messages[0].queueError).toBeUndefined();
  expect(hasLocalPrompt(state)).toBe(false);
}

it("cold replay retains the stamped Claude identity and confirmation", async () => {
  const state = await replayChat(emptyChat(), [stamped()], 0, () => false);
  expect(state.messages[0]).toMatchObject({ turnId: "local", echo: "claude-native-echo", delivery: "dispatched" });
});

it("a confirmed cache/sidebar seed takes over the local identity, attachments and queue state", () => {
  confirmed(withLocalPrompts(reduceChat(emptyChat(), echo()), pending(), true));
});

it("an old unstamped preview cannot erase the host stamp before the retained local copy is reconciled", () => {
  const replayed = reduceChat(emptyChat(), echo());
  const current = pending();
  current.messages.unshift({ ...replayed.messages[0], turnId: undefined, delivery: undefined });
  confirmed(withLocalPrompts(replayed, current));
});

it.each(["live", "cold"])("a stamped source id confirms an appended local prompt by identity (%s)", path => {
  const local = pending();
  local.messages[0].sourceTurnIds = ["local", "appended-id"];
  const state = path === "live" ? reduceChat(local, echo("appended-id"))
    : withLocalPrompts(reduceChat(emptyChat(), echo("appended-id")), local);
  confirmed(state);
  expect(state.messages[0].sourceTurnIds).toEqual(["local", "appended-id"]);
});

it("keeps confirmed attachments and identity when Load earlier rebuilds the same echo, but releases words outside the window", async () => {
  let state = pending();
  const history = new ChatHistory(), catchUp = new CatchUp();
  const options = { id: "history", key: "chat:history", catchUp, history, getState: () => state,
    publish: (next: ChatState) => { state = next; }, cancelled: () => false, request: async () => [] };
  await loadChat({ ...options, requestPage: async () => ({ events: [stamped(2)], context: [], before: 2 }) });
  confirmed(state);
  await loadEarlierChat({ ...options, requestPage: async before => before === 2
    ? { events: [{ seq: 1, event: { type: "system" } }], context: [], before: null }
    : { events: [stamped(2)], context: [], before: 2 } });
  confirmed(state);
  expect(withLocalPrompts(emptyChat(), state).messages).toEqual([]);
});

it.each(["cold", "cached-prefix", "cached-echo", "page-context", "live-tail", "earlier"])(
  "reconciles a stamped echo across release and %s replay", async path => {
    let state = chatPreviewState(pending());
    const history = new ChatHistory(), catchUp = new CatchUp();
    const options = { id: "a", key: "chat:a", catchUp, history, getState: () => state,
      publish: (next: ChatState) => { state = next; }, cancelled: () => false };
    if (path === "cached-prefix" || path === "cached-echo") {
      await saveChatCheckpoint({ id: "a", seq: 1, updatedAt: 1,
        state: path === "cached-echo" ? reduceChat(emptyChat(), echo()) : emptyChat() });
    }
    await loadChat({ ...options, request: async () => {
      if (path === "live-tail") { catchUp.live("chat:a", 2, echo()); return []; }
      return path === "cached-echo" || path === "earlier" ? [] : [stamped(path === "cached-prefix" ? 2 : 1)];
    }, ...(path === "page-context" || path === "earlier" ? { requestPage: async () => ({
      events: [{ seq: 2, event: { type: "result" } }],
      context: path === "page-context" ? [stamped()] : [], before: 2,
    }) } : {}) });
    if (path === "earlier") await loadEarlierChat({ ...options, request: async () => [],
      requestPage: async before => before === 2
        ? { events: [stamped()], context: [], before: null }
        : { events: [{ seq: 2, event: { type: "result" } }], context: [], before: 2 },
    });
    confirmed(state);
    state = reconcileQueueSnapshot(state, state, { live: true, queuedTurnIds: [] });
    confirmed(state);
    expect(chatPreviewState(state).messages.filter(m => !m.echo && !m.takenUp)).toEqual([]);
  },
);

it.each(["live", "cold"])("same words with a different stamped id never confirm the new prompt (%s)", async path => {
  let state = pending();
  if (path === "live") state = reduceChat(state, echo("older-turn"));
  else await loadChat({ id: "different", key: "chat:different", catchUp: new CatchUp(),
    getState: () => state, publish: next => { state = next; }, cancelled: () => false,
    request: async () => [{ seq: 1, event: echo("older-turn") }],
  });
  expect(state.messages).toHaveLength(2);
  expect(state.messages.find(m => m.turnId === "local")).toEqual(pending().messages[0]);
  expect(hasLocalPrompt(state)).toBe(true);
});

it("a missing queue entry is not an echo", () => {
  const local = pending();
  const state = reconcileQueueSnapshot(local, local, { live: true, queuedTurnIds: [] });
  expect(state.messages[0].echo).toBeUndefined();
  expect(state.messages[0].takenUp).toBeFalsy();
  expect(hasLocalPrompt(state)).toBe(true);
});

it("ten confirmed 200KB prompts leave no local copies after each scoped release", async () => {
  let state = emptyChat();
  const frames: Frame[] = [];
  for (let i = 0; i < 10; i++) {
    const text = `${i}:` + "x".repeat(200_000), turn = `local-${i}`;
    state = addUserTurn(state, text, attachments, 10 + i, turn);
    frames.push({ seq: i + 1, event: echo(turn, text, `native-${i}`) });
    await loadChat({ id: "growth", key: "chat:growth", catchUp: new CatchUp(), history: new ChatHistory(),
      getState: () => state, publish: next => { state = next; }, cancelled: () => false,
      request: async () => frames, requestPage: async () => ({ events: frames, context: [], before: 1 }),
    });
    expect(state.messages.filter(m => m.turnId === turn)).toHaveLength(1);
    expect(hasLocalPrompt(state)).toBe(false);
    const small = chatPreviewState(state);
    state = { ...small, messages: small.messages.filter(m => m.role === "user" && !m.echo && !m.takenUp) };
    expect(state.messages).toEqual([]);
  }
});

it("replays the captured Claude command fixture with the stamp the host adds, without editing the capture", async () => {
  let stampedCount = 0;
  const frames: Frame[] = commandEcho.trim().split("\n").map((line, i) => {
    const event = JSON.parse(line);
    // agent_chat::stamp_user_turn_id adds browser identity to the native echo.
    if (event.type === "user" && event.isReplay === true && !event.parent_tool_use_id) {
      event.octiq_user_turn_id = "fixture-turn";
      stampedCount++;
    }
    return { seq: i + 1, event };
  });
  expect(stampedCount).toBe(1);
  let state = chatPreviewState(addUserTurn(emptyChat(), "/list-all-branches", attachments, 10, "fixture-turn"));
  await loadChat({ id: "fixture", key: "chat:fixture", catchUp: new CatchUp(), getState: () => state,
    publish: next => { state = next; }, cancelled: () => false, request: async () => frames });
  const users = state.messages.filter(m => m.role === "user");
  expect(users).toHaveLength(1);
  expect(users[0]).toMatchObject({ id: "u:fixture-turn", turnId: "fixture-turn", delivery: "dispatched", attachments });
  expect(users[0].echo).toBeTruthy();
  expect(hasLocalPrompt(state)).toBe(false);
});
