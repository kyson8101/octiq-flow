// History drawn at a place in the transcript rather than at its end: the head
// before the first turn, and a mark under the turn holding a given message.
// This is where a settled handover goes, so it no longer follows new messages.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({
  knownPath: () => undefined,
  askPaths: () => {},
  subscribePaths: () => () => {},
}));

import type { Message } from "../lib/chat";
import { MessageList } from "./MessageList";

const say = (id: string, role: Message["role"], text: string): Message => ({
  id, role, blocks: [{ kind: "text", text }], streaming: false,
});

const messages = [
  say("u1", "user", "first question"),
  say("a1", "assistant", "first answer"),
  say("u2", "user", "second question"),
  say("a2", "assistant", "second answer"),
];

describe("history placed in the transcript", () => {
  it("draws the head before the first turn and a mark under its own turn, not at the end", () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={messages}
        busy={false}
        head={<p>HEAD-LINE</p>}
        marks={new Map([["a1", <p key="a1">MARK-LINE</p>]])}
        tail={<p>TAIL-CARD</p>}
      />,
    );
    const at = (text: string) => html.indexOf(text);
    expect(at("HEAD-LINE")).toBeGreaterThan(-1);
    expect(at("HEAD-LINE")).toBeLessThan(at("first question"));
    expect(at("MARK-LINE")).toBeGreaterThan(at("first answer"));
    expect(at("MARK-LINE")).toBeLessThan(at("second question"));
    expect(at("TAIL-CARD")).toBeGreaterThan(at("second answer"));
  });

  it("draws nothing for a mark whose message is not in the transcript", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={messages} busy={false} marks={new Map([["gone", <p key="gone">MARK-LINE</p>]])} />,
    );
    expect(html).not.toContain("MARK-LINE");
  });
});
