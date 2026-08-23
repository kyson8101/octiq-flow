// Card 75 — the skill a typed command resolved to, shown as a badge.
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

const typed = (text: string, ranSkill?: string): Message => ({
  id: "u1",
  role: "user",
  blocks: [{ kind: "text", text }],
  streaming: false,
  ...(ranSkill ? { ranSkill } : {}),
});

describe("a typed slash command the harness rewrote", () => {
  it("shows the words you typed, not the rewritten form", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={[typed("/execute cards 67-73", "pandahrms:execute")]} busy={false} />,
    );

    expect(html).toContain("/execute cards 67-73");
  });

  it("names the skill it resolved to, apart from your words", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={[typed("/execute cards 67-73", "pandahrms:execute")]} busy={false} />,
    );

    expect(html).toContain("msg-ran");
    expect(html).toContain("pandahrms:execute");
  });

  it("says nothing when nothing was rewritten", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={[typed("/list-all-branches")]} busy={false} />,
    );

    expect(html).not.toContain("msg-ran");
  });

  it("says nothing on an ordinary message", () => {
    const html = renderToStaticMarkup(
      <MessageList messages={[typed("just a question")]} busy={false} />,
    );

    expect(html).not.toContain("msg-ran");
  });
});
