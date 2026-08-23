// Card 80 — the CLI's own report, and card 81 — a compaction is not a speaker.
//
// Its own file, for the reason the sibling room file gives: `MessageList.test.tsx`
// belongs to another piece of work in flight.
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

describe("a report from the tool the agent runs inside", () => {
  it("is drawn as the tool speaking, not as a reply", () => {
    const html = render(event([{ kind: "notice", text: "Set model to Opus 5" }]));

    expect(html).toContain("Set model to Opus 5");
    expect(html).toContain("cli-note");
  });

  it("is not put in Claude's mouth", () => {
    // Claude did not say it. `/model` was answered by the CLI without the model
    // being involved at all.
    const html = render(event([{ kind: "notice", text: "Set model to Opus 5" }]));

    expect(html).not.toContain(">Claude<");
  });
});

describe("a compaction", () => {
  it("is not put in Claude's mouth either", () => {
    // Same reason, and it has always been wrong: summarising the history is
    // something that HAPPENED to the conversation, not a turn anybody took.
    const html = render(event([{ kind: "compacted", text: "", trigger: "manual" }]));

    expect(html).not.toContain(">Claude<");
  });
});

describe("a reply that also carries an event", () => {
  it("still says who wrote it", () => {
    // Only a turn made ENTIRELY of events loses the name. A reply with prose in
    // it is still somebody talking.
    const html = render(
      event([
        { kind: "text", text: "done" },
        { kind: "notice", text: "Set model to Opus 5" },
      ]),
    );

    expect(html).toContain(">Claude<");
  });
});
