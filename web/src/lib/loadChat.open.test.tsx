import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));
import { MessageList } from "../components/MessageList";
import { emptyChat, type ChatState } from "./chat";
import { CatchUp } from "./catchUp";
import { ChatHistory, type ChatPage } from "./chatHistory";
import { saveChatCheckpoint } from "./chatCache";
import { replayChat } from "./replayChat";
import { loadChat, loadEarlierChat, CHAT_WINDOW_PAGES } from "./loadChat";
import taskStream from "./__fixtures__/task-subagent.jsonl?raw";

// Verbatim captured events, split at the paging transport boundary. No stream
// event is manufactured or edited. These suffixes draw no top-level turn.
const capture = taskStream.trim().split("\n")
  .map((line, i) => ({ seq: i + 1, event: JSON.parse(line) as { type: string; subtype?: string } }));
const context = capture.filter(({ event }) => event.type === "system" && event.subtype === "init").slice(0, 1);

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

function setup() {
  let state = emptyChat();
  const history = new ChatHistory();
  const options = { id: "opened", key: "chat:opened", history, catchUp: new CatchUp(),
    getState: () => state, publish: (next: ChatState) => { state = next; }, cancelled: () => false,
    request: vi.fn(async () => { throw new Error("must keep reads paged"); }) };
  const html = () => renderToStaticMarkup(<MessageList conversationId="opened" messages={state.messages}
    busy={state.busy} hasEarlier={history.hasEarlier("opened")} />);
  return { options, html };
}

it.each([
  ["startup metadata", 103, 105],
  ["subagent-only messages", 69, 71],
  ["a tool result without its call", 56, 57],
] as const)("opens with the latest visible conversation behind %s", async (_label, start, end) => {
  const { options, html } = setup();
  const recent: ChatPage = { events: capture.slice(start, end), context, before: start + 1 };
  const older: ChatPage = { events: capture.slice(0, start), context: [], before: null };
  const requestPage = vi.fn(async (before: number | null) => before === null ? recent : older);
  await loadChat({ ...options, requestPage });
  expect(html()).toContain("Use the Task tool once");
  expect(html()).toContain("I&#x27;ll use the Agent tool");
  expect(options.catchUp.mark(options.key)).toBe(end);
  expect(options.history.hasEarlier(options.id)).toBe(false);
  expect(requestPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, start + 1]);
  expect(options.request).not.toHaveBeenCalled();
});

it("reproduces the old empty opening and the manual Load earlier workaround", async () => {
  const { options, html } = setup();
  // No earlier cursor until the initial load commits: the old reader can only
  // show the history row, and the existing manual prepend does recover it.
  await loadChat({ ...options, requestPage: async () => ({ events: capture.slice(103, 105), context, before: null }) });
  options.history.set(options.id, 104);
  expect(html()).toContain("Load earlier messages");
  expect(html()).not.toContain("Use the Task tool once");
  await loadEarlierChat({ ...options, requestPage: async (before) => before === null
    ? { events: capture.slice(103, 105), context, before: 104 }
    : { events: capture.slice(0, 103), context: [], before: null } });
  expect(html()).toContain("Use the Task tool once");
});


it("leaves a visible recent page alone", async () => {
  const { options, html } = setup();
  const requestPage = vi.fn(async () => ({ events: capture.slice(0, 103), context: [], before: 1 }));
  await loadChat({ ...options, requestPage });
  expect(html()).toContain("DONE");
  expect(requestPage).toHaveBeenCalledExactlyOnceWith(null);
  expect(options.history.hasEarlier(options.id)).toBe(true);
});

it("keeps the latest live answer exactly once while refilling an empty opening", async () => {
  const { options, html } = setup();
  const requestPage = vi.fn(async (before: number | null): Promise<ChatPage> => {
    if (before === null) return { events: capture.slice(104, 105), context, before: 105 };
    if (before === 105) return { events: capture.slice(103, 104), context, before: 104 };
    for (const frame of [capture[126], capture[130]]) options.catchUp.live(options.key, frame.seq, frame.event);
    return { events: capture.slice(0, 103), context: [], before: null };
  });
  await loadChat({ ...options, requestPage });
  expect(html()).toContain("Use the Task tool once");
  expect(html().match(/Agent completed\. Result: PONG/g)).toHaveLength(1);
  expect(options.catchUp.mark(options.key)).toBe(131);
  expect(requestPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, 105, 104]);
});

it("recovers a checkpoint that contains only bookkeeping at the current tail", async () => {
  const { options, html } = setup();
  const state = await replayChat(emptyChat(), capture.slice(103, 105), 0, () => false);
  await saveChatCheckpoint({ id: options.id, state, seq: 105, updatedAt: 1 });
  const request = vi.fn(async () => []);
  await loadChat({ ...options, request, requestPage: async before => before === null
    ? { events: capture.slice(103, 105), context, before: 104 }
    : { events: capture.slice(0, 103), context: [], before: null } });
  expect(html()).toContain("Use the Task tool once");
  expect(request).toHaveBeenCalledExactlyOnceWith(105);
  expect(options.catchUp.mark(options.key)).toBe(105);
});

it("keeps the checkpoint tail downloaded after the recent page was read", async () => {
  const { options, html } = setup();
  const state = await replayChat(emptyChat(), capture.slice(103, 104), 0, () => false);
  await saveChatCheckpoint({ id: options.id, state, seq: 104, updatedAt: 1 });
  const request = vi.fn(async () => capture.slice(104, 105));
  await loadChat({ ...options, request, requestPage: async before => before === null
    ? { events: capture.slice(103, 104), context, before: 104 }
    : { events: capture.slice(0, 103), context: [], before: null } });
  expect(html()).toContain("Use the Task tool once");
  expect(request).toHaveBeenCalledExactlyOnceWith(104);
  expect(options.catchUp.mark(options.key)).toBe(105);
});

it("bounds invisible-page scanning and leaves a usable earlier cursor", async () => {
  const { options, html } = setup();
  const metadata = capture.filter(({ event }) => event.type === "system" && event.subtype === "thinking_tokens");
  const requestPage = vi.fn(async (before: number | null) => {
    const event = metadata.filter(frame => before === null || frame.seq < before).at(-1)!;
    return { events: [event], context, before: event.seq };
  });
  await loadChat({ ...options, requestPage });
  expect(requestPage).toHaveBeenCalledTimes(CHAT_WINDOW_PAGES);
  expect(options.catchUp.mark(options.key)).toBe(metadata.at(-1)!.seq);
  expect(html()).toContain("Load earlier messages");
  expect(options.history.get(options.id)?.before).toBe(metadata.at(-CHAT_WINDOW_PAGES)!.seq);
});

it("rejects a stuck cursor instead of repeatedly downloading it", async () => {
  const { options } = setup();
  const requestPage = vi.fn(async () => ({ events: capture.slice(103, 105), context, before: 104 }));
  await expect(loadChat({ ...options, requestPage })).rejects.toThrow("History cursor did not advance");
  expect(requestPage).toHaveBeenCalledTimes(2);
  expect(options.getState().messages).toEqual([]);
});

it("does not publish a refill after the chat leaves the screen", async () => {
  const { options } = setup();
  let cancelled = false;
  const publish = vi.fn(options.publish);
  await loadChat({ ...options, publish, cancelled: () => cancelled, requestPage: async before => {
    if (before === null) return { events: capture.slice(103, 105), context, before: 104 };
    cancelled = true;
    return { events: capture.slice(0, 103), context: [], before: null };
  } });
  expect(publish).not.toHaveBeenCalled();
});
