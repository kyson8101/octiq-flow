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

describe("the host's turn that tells an agent its plan was started", () => {
  // The bubble said `The agent was told to begin` whatever became of the
  // turn, under a Plan panel that said it was not sent.
  const start = (extra: Partial<Message>) => draw({ turnId: "octiq-plan-start-7f", blocks: [{ kind: "text", text: "The person started the plan. Begin." }], ...extra }, false);
  const detail = (html: string) => /<span class="wrap-up-note-detail">([^<]*)<\/span>/.exec(html)?.[1];

  it("says a turn whose send failed did not reach the agent", () => {
    const html = start({ delivery: "failed" });
    expect(html).toContain('<span class="wrap-up-note-label">Plan started</span>');
    expect(detail(html)).toBe("Not sent · this turn did not reach the agent");
    expect(html).not.toContain("The agent was told to begin");
    // The host's words are still behind the disclosure, and still its own.
    expect(html).toContain("The person started the plan. Begin.");
  });

  it("says a turn lost from the queue did not reach the agent", () => {
    const html = start({ delivery: "queued", queueLost: true });
    expect(detail(html)).toBe("Lost from the queue · this turn did not reach the agent");
    expect(html).not.toContain("The agent was told to begin");
    expect(html).not.toContain("Telling the agent after the current reply");
  });

  it("says told only of a turn that was handed over, and waiting of one still queued", () => {
    expect(detail(start({ delivery: "dispatched" }))).toBe("The agent was told to begin");
    expect(detail(start({ delivery: "failed", echo: "e1" }))).toBe("The agent was told to begin");
    expect(detail(start({ delivery: "queued" }))).toBe("Telling the agent after the current reply");
  });
});

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
    expect(draw({ delivery: "dispatched" })).toContain("Awaiting agent confirmation");
    expect(draw({ delivery: "dispatched" })).not.toContain("The agent has this message");
    expect(draw({ delivery: "unknown" })).toContain("Restore to composer");
  });

  it("shows the host's own reason under a message it could not start", () => {
    const why = "The chat's folder /trees/app/task-1 was removed and could not be restored: /repos/app is gone too. Start a new chat.";
    const html = draw({ delivery: "unknown", queueError: why }, false);
    expect(html).toContain("Delivery unconfirmed");
    expect(html).toContain("was removed and could not be restored");
    expect(html).toContain('role="alert"');
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
    const working = reduceChat(addUserTurn(emptyChat(), "do the thing", [], 1, "u-1"), {
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
