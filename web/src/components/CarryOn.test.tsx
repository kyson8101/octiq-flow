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
import { CARRY_ON, CARRY_ON_HEAD } from "../lib/carryOn";
import { CarryOn } from "./CarryOn";
import { MessageList } from "./MessageList";

const LINE = "asked it to carry on after the backend stopped";

const message = (text: string, relay?: string): Message => ({
  id: "m0",
  role: "user",
  blocks: [{ kind: "text", text }],
  streaming: false,
  ...(relay ? { relay } : {}),
});

describe("the carry-on prompt", () => {
  it("is marked as one line when it is sent", () => {
    const state = addUserTurn(emptyChat(), CARRY_ON);
    const sent = state.messages[state.messages.length - 1];

    expect(sent.relay).toBe(LINE);
  });

  it("keeps its words, because the echo is matched by text", () => {
    // The agent replays what it was given, and that echo claims this bubble.
    // Trimming it down to its label would leave the echo matching nothing, and
    // the whole instruction would arrive as a second message nobody sent.
    const state = addUserTurn(emptyChat(), CARRY_ON);
    const sent = state.messages[state.messages.length - 1];

    expect(sent.blocks).toEqual([{ kind: "text", text: CARRY_ON }]);
  });

  it("leaves a message somebody typed alone", () => {
    const state = addUserTurn(emptyChat(), "carry on where you stopped");
    const sent = state.messages[state.messages.length - 1];

    expect(sent.relay).toBeUndefined();
  });

  it("is drawn as the line, not as the instruction", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={[message(CARRY_ON, LINE)]} busy={false} />,
    );

    expect(html).toContain(LINE);
    expect(html).not.toContain(CARRY_ON_HEAD);
    expect(html).not.toContain("Carry on from where you stopped");
  });
});

describe("the strip above the prompt box", () => {
  it("says nothing was lost, and offers the one thing to do", () => {
    const html = renderToStaticMarkup(<CarryOn onCarryOn={() => {}} />);

    expect(html).toContain("Nothing was lost");
    expect(html).toContain("Carry on");
  });
});
