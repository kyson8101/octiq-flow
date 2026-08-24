// The follow-up brief the host is handed once the other agents have spoken.
//
// Its own file, like the room tests beside it: this is one piece of work, and
// two chats editing one test file in a shared checkout is how you lose
// somebody else's tests.
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
import { RELAY_HEAD } from "../lib/relay";
import { MessageList } from "./MessageList";

const BRIEF = `${RELAY_HEAD}

--- Dee ---
The migration is not reversible.

=== over to you ===
Those are the other agents sitting in this chat, not the person.`;

let n = 0;
const typed = (text: string): Message => ({
  id: `m${n++}`,
  role: "user",
  blocks: [{ kind: "text", text }],
  streaming: false,
});

const render = (...messages: Message[]) =>
  renderToStaticMarkup(<MessageList messages={messages} busy={false} />);

describe("a follow-up brief in the transcript", () => {
  it("is drawn as one line instead of quoting the discussion twice", () => {
    const html = render({ ...typed(BRIEF), relay: "passed on what Dee said" });

    expect(html).toContain("passed on what Dee said");
    // The answers it quotes are the messages directly above it on screen.
    expect(html).not.toContain("The migration is not reversible.");
    expect(html).not.toContain(RELAY_HEAD);
  });

  it("keeps the words on the message, because the echo is matched by text", () => {
    // The bubble is claimed when the agent replays what it was given. Trimming
    // the brief down to its label would leave the echo matching nothing, and
    // the whole brief would arrive as a SECOND message nobody sent.
    const state = addUserTurn(emptyChat(), BRIEF);
    const message = state.messages[state.messages.length - 1];

    expect(message.relay).toBe("passed on what Dee said");
    expect(message.blocks).toEqual([{ kind: "text", text: BRIEF }]);
  });

  it("never swallows the message typed beside it", () => {
    // Turns group by side, and a user turn sits next to a user turn. Grouped,
    // the person's own words would be drawn as the relay line and vanish.
    const html = render(typed("ask Dee about the migration"), {
      ...typed(BRIEF),
      relay: "passed on what Dee said",
    });

    expect(html).toContain("ask Dee about the migration");
    expect(html).toContain("passed on what Dee said");
  });

  it("leaves an ordinary message as a bubble", () => {
    const html = render(typed("what did Dee say?"));

    expect(html).toContain("what did Dee say?");
    expect(html).not.toContain("msg-relay");
  });
});
