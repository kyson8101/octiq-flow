// Picking up a turn the backend stopped mid-answer.
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
  CHAT_SERVICE_RESUMED,
  CHAT_SERVICE_RESUMED_HEAD,
  CHAT_SERVICE_RESUMED_REPLY,
} from "../lib/carryOn";
import { CarryOn } from "./CarryOn";
import { MessageList } from "./MessageList";

const LINE = CHAT_SERVICE_RESUMED_REPLY;

const message = (text: string, relay?: string): Message => ({
  id: "m0",
  role: "user",
  blocks: [{ kind: "text", text }],
  streaming: false,
  ...(relay ? { relay } : {}),
});

describe("the service-resumed notice", () => {
  it("is marked as one line when it is sent", () => {
    const state = addUserTurn(emptyChat(), CHAT_SERVICE_RESUMED);
    const sent = state.messages[state.messages.length - 1];

    expect(sent.relay).toBe(LINE);
  });

  it("keeps its words, because the echo is matched by text", () => {
    // The agent replays what it was given, and that echo claims this bubble.
    // Trimming it down to its label would leave the echo matching nothing, and
    // the whole instruction would arrive as a second message nobody sent.
    const state = addUserTurn(emptyChat(), CHAT_SERVICE_RESUMED);
    const sent = state.messages[state.messages.length - 1];

    expect(sent.blocks).toEqual([{ kind: "text", text: CHAT_SERVICE_RESUMED }]);
  });

  it("leaves a message somebody typed alone", () => {
    const state = addUserTurn(emptyChat(), "carry on where you stopped");
    const sent = state.messages[state.messages.length - 1];

    expect(sent.relay).toBeUndefined();
  });

  it("is drawn as the line, not as the instruction", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={[message(CHAT_SERVICE_RESUMED, LINE)]} busy={false} />,
    );

    expect(html).toContain(LINE);
    expect(html).not.toContain(CHAT_SERVICE_RESUMED_HEAD);
    expect(html).not.toContain("Reply only with");
  });
});

describe("the strip above the prompt box", () => {
  it("does not offer continuation without process evidence", () => {
    const html = renderToStaticMarkup(<CarryOn onCarryOn={() => {}} />);

    expect(html).not.toContain("Nothing was lost");
    expect(html).toContain("Checking whether");
    expect(html).not.toContain("<button");
  });

  it("offers a neutral resume action instead of carry-on instructions", () => {
    const html = renderToStaticMarkup(
      <CarryOn
        onCarryOn={() => {}}
        evidence={{ connected: true, rosterKnown: true, busy: true, live: false }}
      />,
    );

    expect(html).toContain("Resume chat");
    expect(html).not.toContain(">Carry on<");
    expect(html).not.toContain("check completed actions");
  });
});
