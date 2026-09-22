// Historical service-resumed turns stay readable after the recovery UI is gone.
//
// Its own file, like the relay and room tests beside it: this is one piece of
// work, and two chats editing one test file in a shared checkout is how you
// lose somebody else's tests.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({
  knownPath: () => undefined,
  askPaths: () => {},
  subscribePaths: () => () => {},
}));

import { addUserTurn, emptyChat, type Message } from "../lib/chat";
import {
  CHAT_SERVICE_RESUMED_HEAD,
  CHAT_SERVICE_RESUMED_REPLY,
} from "../lib/carryOn";
import { MessageList } from "./MessageList";

const LINE = CHAT_SERVICE_RESUMED_REPLY;
const HISTORICAL_SERVICE_RESUMED = `${CHAT_SERVICE_RESUMED_HEAD}

Reply only with: ${CHAT_SERVICE_RESUMED_REPLY}`;

const message = (text: string, relay?: string): Message => ({
  id: "m0",
  role: "user",
  blocks: [{ kind: "text", text }],
  streaming: false,
  ...(relay ? { relay } : {}),
});

describe("the historical service-resumed notice", () => {
  it("is marked as one line when an old prompt is replayed", () => {
    const state = addUserTurn(emptyChat(), HISTORICAL_SERVICE_RESUMED);
    const sent = state.messages[state.messages.length - 1];

    expect(sent.relay).toBe(LINE);
  });

  it("keeps its words, because the echo is matched by text", () => {
    // The agent replays what it was given, and that echo claims this bubble.
    // Trimming it down to its label would leave the echo matching nothing, and
    // the whole instruction would arrive as a second message nobody sent.
    const state = addUserTurn(emptyChat(), HISTORICAL_SERVICE_RESUMED);
    const sent = state.messages[state.messages.length - 1];

    expect(sent.blocks).toEqual([{ kind: "text", text: HISTORICAL_SERVICE_RESUMED }]);
  });

  it("leaves a message somebody typed alone", () => {
    const state = addUserTurn(emptyChat(), "carry on where you stopped");
    const sent = state.messages[state.messages.length - 1];

    expect(sent.relay).toBeUndefined();
  });

  it("is drawn as the line, not as the instruction", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={[message(HISTORICAL_SERVICE_RESUMED, LINE)]} busy={false} />,
    );

    expect(html).toContain(LINE);
    expect(html).not.toContain(CHAT_SERVICE_RESUMED_HEAD);
    expect(html).not.toContain("Reply only with");
  });
});
