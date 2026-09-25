// Somebody else's words, handed over by the harness, are neither bubble.
//
// Its own file, for the reason the sibling notice file gives:
// `MessageList.test.tsx` belongs to another piece of work in flight.
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

const event = (blocks: Message["blocks"]): Message => ({
  id: "m1",
  role: "assistant",
  blocks,
  streaming: false,
});

const render = (...messages: Message[]) =>
  renderToStaticMarkup(<MessageList messages={messages} busy={false} />);

/** Long enough to be shut on arrival — a real report runs to pages. */
const REPORT = `Verdict — APPROVE WITH FOLLOW-UP\n${"It touches auth and the company cookie. ".repeat(20)}`;

describe("a subagent's report handed back", () => {
  it("is drawn as its own voice, not as a reply", () => {
    const html = render(
      event([{ kind: "peer", source: "handback", from: "ac73ceeede1748538", text: REPORT }]),
    );

    expect(html).toContain("peer-note");
    expect(html).not.toContain(">Claude<");
  });

  it("says which subagent, in a length anyone can read", () => {
    const html = render(
      event([{ kind: "peer", source: "handback", from: "ac73ceeede1748538", text: REPORT }]),
    );

    expect(html).toContain("subagent ac73ceee reported back");
    expect(html).not.toContain("ac73ceeede1748538");
  });

  it("arrives shut, quoting its opening line so it can be judged unopened", () => {
    const html = render(
      event([{ kind: "peer", source: "handback", from: "ac73ceeede1748538", text: REPORT }]),
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Verdict — APPROVE WITH FOLLOW-UP");
    // Shut means shut: the pages below the first line are not on the screen.
    expect(html).not.toContain("It touches auth and the company cookie.");
  });
});

describe("another Claude session's message", () => {
  const SHORT = "Yes: this session wrote card 12 and it is complete in the working tree.";

  it("names the session the way its own user named it", () => {
    const html = render(
      event([{ kind: "peer", source: "session", from: "pandahrms-web-2d", text: SHORT }]),
    );

    expect(html).toContain("pandahrms-web-2d sent a message");
  });

  it("is simply readable when it is short enough to read", () => {
    // A paragraph asking a question, shut away behind a chevron, hides the
    // whole point of it.
    const html = render(
      event([{ kind: "peer", source: "session", from: "pandahrms-web-2d", text: SHORT }]),
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(SHORT);
  });
});

describe("a reply that also carries a peer's message", () => {
  it("still says who wrote the reply", () => {
    // Only a turn made ENTIRELY of events loses the name.
    const html = render(
      event([
        { kind: "text", text: "done" },
        { kind: "peer", source: "session", from: "pandahrms-web-2d", text: "ok" },
      ]),
    );

    expect(html).toContain(">Claude<");
  });
});
