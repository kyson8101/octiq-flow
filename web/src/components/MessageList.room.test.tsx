// Card 66 — how a room reads on screen.
//
// A separate file from `MessageList.test.tsx` on purpose: that one belongs to
// another piece of work in flight, and two chats editing one test file in a
// shared checkout is how you lose someone else's tests.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The same three stubs the sibling file uses, and for the same reasons: the
// attachment strip and the path store both talk to the socket, and a server
// render never gets as far as an effect.
vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({
  knownPath: () => undefined,
  askPaths: () => {},
  subscribePaths: () => () => {},
}));

import type { Message, Speaker } from "../lib/chat";
import { MessageList } from "./MessageList";

const CODEX: Speaker = { id: "s1", name: "Codex", agent: "codex" };
const CLAUDE: Speaker = { id: "s2", name: "Second opinion", agent: "claude" };

let n = 0;
const answered = (text: string, speaker?: Speaker): Message => ({
  id: `m${n++}`,
  role: "assistant",
  blocks: [{ kind: "text", text }],
  streaming: false,
  ...(speaker ? { speaker } : {}),
});

const render = (...messages: Message[]) =>
  renderToStaticMarkup(<MessageList messages={messages} busy={false} />);

describe("a message written by a seat", () => {
  it("is labelled with the seat's own name, not the host's", () => {
    const html = render(answered("I checked the repo.", CODEX));

    expect(html).toContain("Codex");
    // The host label is hardcoded "Claude". A seat that still said Claude would
    // be the whole feature failing quietly.
    expect(html).not.toContain(">Claude<");
  });

  it("draws the seat's own mark beside the name", () => {
    const html = render(answered("I checked the repo.", CODEX));

    expect(html).toContain("agent-logo");
    expect(html).toContain("is-codex");
  });

  it("still says Claude for the host, exactly as before", () => {
    const html = render(answered("the host speaking"));

    expect(html).toContain("Claude");
    expect(html).not.toContain("agent-logo");
  });
});

describe("two seats answering one after the other", () => {
  it("gets a label each, instead of merging into one turn", () => {
    // Consecutive assistant messages are drawn as ONE turn with ONE label —
    // right for a single agent thinking, calling a tool and answering; wrong
    // the moment two different voices are consecutive, because the second
    // voice's words would appear under the first one's name.
    const html = render(
      answered("Codex here, the file is unchanged.", CODEX),
      answered("Second opinion here, I disagree.", CLAUDE),
    );

    expect(html).toContain("Codex");
    expect(html).toContain("Second opinion");
    expect(html.match(/msg-role/g) ?? []).toHaveLength(2);
  });

  it("still merges consecutive messages from the SAME seat", () => {
    const html = render(
      answered("first half", CODEX),
      answered("second half", CODEX),
    );

    expect(html).toContain("first half");
    expect(html).toContain("second half");
    expect(html.match(/msg-role/g) ?? []).toHaveLength(1);
  });

  it("does not merge a seat's turn into the host's", () => {
    const html = render(answered("the host"), answered("the seat", CODEX));

    expect(html.match(/msg-role/g) ?? []).toHaveLength(2);
  });
});
