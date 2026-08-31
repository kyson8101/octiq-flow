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

const renderAs = (hostName: string, ...messages: Message[]) =>
  renderToStaticMarkup(<MessageList messages={messages} busy={false} hostName={hostName} />);

describe("a message written by a seat", () => {
  it("is labelled with the seat's own name, not the host's", () => {
    const html = render(answered("I checked the repo.", CODEX));

    expect(html).toContain("Codex");
    // The host label defaults to "Claude" here. A seat that still said Claude
    // would be the whole feature failing quietly.
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

// The label over a host reply used to be the literal "Claude", written when
// Claude was the only agent there was. A Codex chat then signed every one of
// its own answers with the other agent's name.
describe("the label over a host reply", () => {
  it("is the provider this conversation runs, not the word Claude", () => {
    const html = renderAs("Codex", answered("I checked the repo."));

    expect(html).toContain(">Codex<");
    expect(html).not.toContain("Claude");
  });

  it("still draws no mark beside it — that is the seats' distinction", () => {
    expect(renderAs("Codex", answered("the host speaking"))).not.toContain("agent-logo");
  });

  it("leaves a seat's own name alone", () => {
    // The host is Claude and the seat is Codex: the two names must not swap,
    // and neither may be applied to the other's words.
    const html = renderAs("Claude", answered("the host speaking"), answered("a seat speaking", CODEX));

    expect(html).toContain(">Claude<");
    expect(html).toContain("Codex");
  });

  it("says the host's name over a turn a Claude SEAT did not write", () => {
    // A room whose host is Codex and whose seat is Claude — the arrangement
    // that made the old literal look right for the wrong reason.
    const html = renderAs("Codex", answered("the host speaking"), answered("a seat speaking", CLAUDE));

    expect(html).toContain(">Codex<");
    expect(html).toContain("Second opinion");
  });
});

describe("a message you addressed to one seat", () => {
  it("says who it went to", () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[
          {
            id: "u1",
            role: "user",
            blocks: [{ kind: "text", text: "what do you think?" }],
            streaming: false,
            to: { id: "s1", name: "Codex" },
          },
        ]}
        busy={false}
      />,
    );

    expect(html).toContain("what do you think?");
    expect(html).toContain("Codex");
  });

  it("says nothing extra when it went to the whole room", () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[
          {
            id: "u1",
            role: "user",
            blocks: [{ kind: "text", text: "morning" }],
            streaming: false,
          },
        ]}
        busy={false}
      />,
    );

    expect(html).toContain("morning");
    expect(html).not.toContain("msg-to");
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

describe("telling one seat's reply from another's at a glance", () => {
  it("marks a seat's turn as a seat's, and the host's as neither", () => {
    // The host is the voice a room never has to identify: it keeps the plain
    // full-width prose every chat has always had, and only the guests are set
    // apart. Mark the host too and a one-seat room reads as two strangers.
    const html = render(answered("the host speaking"), answered("the seat speaking", CODEX));

    expect(html.match(/msg-seat/g) ?? []).toHaveLength(1);
  });

  it("gives two seats two different colours", () => {
    const html = render(answered("Codex here.", CODEX), answered("I disagree.", CLAUDE));
    const tints = [...html.matchAll(/data-tint="(\d+)"/g)].map((m) => m[1]);

    expect(tints).toHaveLength(2);
    expect(new Set(tints).size).toBe(2);
  });

  it("keeps a seat's colour the same across the whole conversation", () => {
    const html = render(
      answered("Codex, first.", CODEX),
      answered("me next.", CLAUDE),
      answered("Codex again.", CODEX),
    );
    const tints = [...html.matchAll(/data-tint="(\d+)"/g)].map((m) => m[1]);

    expect(tints).toHaveLength(3);
    expect(tints[0]).toBe(tints[2]);
    expect(tints[0]).not.toBe(tints[1]);
  });
});
