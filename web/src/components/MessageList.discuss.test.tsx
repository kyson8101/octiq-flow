// A message a writer kept from the agent (`require_workspace_access`) offers
// to go again read-only, to discuss: any chat, whoever it is with. Nothing
// else that failed does, and nothing the agent already has.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { MessageList } from "./MessageList";
import type { Message } from "../lib/chat";
import { canDiscussUnsent, isWriterConflict } from "../lib/writerConflict";

const WRITER = "This checkout has an active writer for task Starfall 30s storyboard. Wait or use a separate worktree.";
const refused: Message = {
  id: "m1", turnId: "u-1", role: "user", streaming: false,
  blocks: [{ kind: "text", text: "Let's brainstorm the next series" }], delivery: "unknown", queueError: WRITER,
};
const draw = (extra: Partial<Message> = {}, discuss = true) => renderToStaticMarkup(
  <MessageList messages={[{ ...refused, ...extra }]} busy={false}
    onRestoreUnsent={() => {}} onDismissUnsent={() => {}}
    onDiscussUnsent={discuss ? () => {} : undefined} />,
);

describe("a message a writer refused", () => {
  it("offers to send it again read-only, beside Restore", () => {
    const html = draw();
    expect(html).toContain(WRITER);
    expect(html).toContain(">Discuss read-only</button>");
    expect(html).toContain("Restore to composer");
  });

  it("offers nothing more for any other failure, a message the agent has, or a read-only transcript", () => {
    expect(draw({ queueError: "CLI unavailable" })).not.toContain("Discuss read-only");
    expect(draw({ echo: "e-1" })).not.toContain("Discuss read-only");
    expect(draw({ takenUp: true })).not.toContain("Discuss read-only");
    expect(draw({}, false)).not.toContain("Discuss read-only");
  });

  it("is recognised by the host's words alone", () => {
    expect(isWriterConflict(WRITER)).toBe(true);
    expect(isWriterConflict("STAR LEAD cannot be handed over: This checkout has an active writer for task X.")).toBe(true);
    expect(isWriterConflict("This workspace is being cleaned up.")).toBe(false);
    expect(isWriterConflict(undefined)).toBe(false);
    expect(canDiscussUnsent({ ...refused, turnId: undefined })).toBe(false);
  });
});
