// The compaction that is RUNNING, and the little truck that hauls its load.
//
// Its own file for the reason the sibling notice/room files give: the big
// `MessageList.test.tsx` belongs to other work in flight.
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

const compacted: Message = {
  id: "m1",
  role: "assistant",
  blocks: [{ kind: "compacted", text: "", trigger: "manual" }],
  streaming: false,
};

describe("a compaction while it runs", () => {
  it("sends a truck along the rule", () => {
    // The one wait with nothing to report: no text, no tool card, no token
    // count. The load moving is the whole of what the row can show.
    const html = renderToStaticMarkup(
      <MessageList messages={[]} busy={true} compactingSince={Date.now()} />,
    );

    expect(html).toContain("compacting-truck");
    expect(html).toContain("summarising history to make room");
  });

  it("keeps it off the reader that cannot see it", () => {
    // Decoration on a row that already says what is happening in words.
    const html = renderToStaticMarkup(
      <MessageList messages={[]} busy={true} compactingSince={Date.now()} />,
    );

    expect(html).toMatch(/class="compacting-truck"[^>]*aria-hidden="true"/);
  });

  it("puts it on the rule the narrow layout keeps", () => {
    // One truck, on the FIRST rule: the second is display:none under 700px, and
    // a truck nobody on a phone can see is a truck for nobody.
    const html = renderToStaticMarkup(
      <MessageList messages={[]} busy={true} compactingSince={Date.now()} />,
    );

    expect(html.match(/compacting-truck"/g)).toHaveLength(1);
    expect(html.indexOf("compacting-truck")).toBeLessThan(html.indexOf("compacted-label"));
  });
});

describe("a compaction that has finished", () => {
  it("leaves the rule behind without the truck", () => {
    // The boundary and the running row are one shape on purpose, so the only
    // thing that must not survive the end of the work is the movement.
    const html = renderToStaticMarkup(<MessageList messages={[compacted]} busy={false} />);

    expect(html).toContain("compacted-line");
    expect(html).not.toContain("compacting-truck");
  });
});
