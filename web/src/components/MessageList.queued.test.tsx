// Delivery controls must reflect server ownership and remain consistent across
// screen sizes, provider acknowledgements, and delayed operations.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { MessageList } from "./MessageList";
import { addUserTurn, emptyChat, reduceChat, type Message } from "../lib/chat";

const sent: Message = {
  id: "m1", turnId: "u-1", role: "user", streaming: false,
  blocks: [{ kind: "text", text: "do the thing" }], delivery: "queued",
};
const draw = (extra: Partial<Message> = {}, busy = true) => renderToStaticMarkup(
  <MessageList messages={[{ ...sent, ...extra }]} busy={busy}
    onStartQueued={() => {}} onCancelQueued={() => {}}
    onRestoreUnsent={() => {}} onDismissUnsent={() => {}} />,
);

describe("message delivery controls", () => {
  it.each([false, true])("offers queued actions independently of another turn's busy state (%s)", (busy) => {
    const html = draw({}, busy);
    expect(html).toContain('>Queued</span>');
    expect(html).toContain('>Send now</button>');
    expect(html).toContain('>Edit</button>');
    expect(html.match(/Send this queued message now/g)).toHaveLength(1);
    expect(html).toContain("Send now stops that reply");
  });

  it.each(["sending", "starting", "dispatched", "unknown", "failed"] as const)("never offers queue mutations for %s", (delivery) => {
    const html = draw({ delivery });
    expect(html).not.toContain("Send this queued message now");
    expect(html).not.toContain("Take this queued message back to edit");
  });

  it("does not infer a queue from missing provider output", () => {
    expect(draw({ delivery: undefined })).toContain("Delivery unconfirmed");
    expect(draw({ delivery: undefined })).not.toContain("Send this queued message now");
    expect(draw({ delivery: "dispatched" })).toContain("Sent to agent");
  });

  it.each(["start", "cancel"] as const)("locks both controls during %s", (queueAction) => {
    const html = draw({ queueAction });
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('aria-busy="true"');
  });

  it.each([false, true])("keeps failed content recoverable while busy=%s", (busy) => {
    const html = draw({ delivery: "failed", queueLost: true }, busy);
    expect(html).toContain("Not sent");
    expect(html).toContain("Restore to composer");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain("Send this queued message now");
  });

  it("removes stale controls after an exact acknowledgement", () => {
    const working = reduceChat(addUserTurn(emptyChat(), "do the thing", [], 1, undefined, "u-1"), {
      type: "turn.started", octiq_user_turn_id: "u-1",
    });
    expect(draw(working.messages[0])).not.toContain("Send this queued message now");
    expect(draw(working.messages[0])).toContain('>Sent</span>');
  });

  it("keeps the bubble text identical before and after pickup", () => {
    const body = (html: string) => html.split('<div class="msg-body">')[1].split('<div class="message-delivery"')[0];
    expect(body(draw())).toBe(body(draw({ delivery: "dispatched", takenUp: true })));
  });

  it("keeps two things you typed as two things, whichever agent this is", () => {
    // This used to assert the opposite for Claude, and the reason it changed is
    // the reason this whole file exists: Claude's follow-ups went straight down
    // its stdin and were nobody's to hold, so consecutive user messages could
    // share a bubble. They are held in OUR queue now, one at a time — so each
    // one has its own clock to lose, and its own ✕ to be taken back by, and
    // neither has anywhere to live in a bubble shared with the other.
    const messages: Message[] = [
      {
        id: "u1",
        role: "user",
        blocks: [{ kind: "text", text: "first" }],
        streaming: false,
        echo: "echo-1",
      },
      {
        id: "u2",
        role: "user",
        blocks: [{ kind: "text", text: "second" }],
        streaming: false,
        echo: "echo-2",
      },
    ];
    const html = renderToStaticMarkup(<MessageList messages={messages} busy={false} />);

    expect(html.match(/class="msg msg-user/g)).toHaveLength(2);
  });

  it("names the earlier queued message above a non-adjacent Codex answer", () => {
    const messages: Message[] = [
      {
        id: "u1",
        role: "user",
        blocks: [{ kind: "text", text: "earlier queued message" }],
        streaming: false,
        takenUp: true,
      },
      {
        id: "u2",
        role: "user",
        blocks: [{ kind: "text", text: "later queued message" }],
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        blocks: [{ kind: "text", text: "a long answer" }],
        streaming: false,
        replyTo: { id: "u1", preview: "earlier queued message" },
      },
    ];
    const html = renderToStaticMarkup(
      <MessageList messages={messages} busy />,
    );

    expect(html).toContain("Replying to");
    expect(html).toContain("earlier queued message");
  });

  it("does not merge two queued Codex answers into one apparent reply", () => {
    const messages: Message[] = [
      {
        id: "u1",
        role: "user",
        blocks: [{ kind: "text", text: "earlier queued message" }],
        streaming: false,
        takenUp: true,
      },
      {
        id: "u2",
        role: "user",
        blocks: [{ kind: "text", text: "later queued message" }],
        streaming: false,
        takenUp: true,
      },
      {
        id: "a1",
        role: "assistant",
        blocks: [{ kind: "text", text: "first answer" }],
        streaming: false,
        replyTo: { id: "u1", preview: "earlier queued message" },
      },
      {
        id: "a2",
        role: "assistant",
        blocks: [{ kind: "text", text: "second answer" }],
        streaming: false,
        replyTo: { id: "u2", preview: "later queued message" },
      },
    ];
    const html = renderToStaticMarkup(
      <MessageList messages={messages} busy={false} />,
    );

    expect(html.match(/class="msg msg-assistant/g)).toHaveLength(2);
    expect(html.match(/class="msg-reply-label"/g)).toHaveLength(2);
  });
});
