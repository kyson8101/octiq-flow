// A queued message must be the same SHAPE as the message it becomes.
//
// The agent echoes a message back only when it starts on it, so the mark comes
// off mid-conversation and unannounced. As a row of its own it took a line and
// the column's gap with it, and every message below stepped up the page the
// moment the agent got to this one. The mark is out of flow now, and these are
// the two facts that keep it that way.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { MessageList } from "./MessageList";
import { addUserTurn, emptyChat, reduceChat, type Message } from "../lib/chat";

const sent: Message[] = [
  { id: "m1", role: "user", blocks: [{ kind: "text", text: "do the thing" }] } as Message,
];

/** `busy` with nothing echoed back is what "queued" IS — see `TurnView`. */
const draw = (busy: boolean) =>
  renderToStaticMarkup(<MessageList messages={sent} busy={busy} />);

describe("the queued mark", () => {
  it("comes off when Codex says it has started the turn", () => {
    const working = reduceChat(
      addUserTurn(emptyChat(), "do the thing"),
      { type: "turn.started" },
    );
    const html = renderToStaticMarkup(
      <MessageList messages={working.messages} busy={working.busy} />,
    );

    expect(html).not.toContain('class="queued"');
    expect(html).not.toContain("is-queued");
  });

  it("is a mark on the message, not a row under it", () => {
    const html = draw(true);
    // Inside the pill. A sibling of `.msg-body` would be a row again whatever
    // its CSS said.
    expect(html).toMatch(/class="msg-body">[\s\S]*class="queued"/);
    expect(html).not.toContain(">queued<");
  });

  it("keeps its meaning without the word", () => {
    // The label was readable text and the clock is not. Whatever replaced it
    // has to say the same thing to a reader who cannot see a picture.
    const html = draw(true);
    expect(html).toContain('role="img"');
    expect(html).toMatch(/aria-label="Sent — the agent has not started on this yet"/);
  });

  it("adds nothing to the message's flow but the mark itself", () => {
    // The real assertion, and the reason this file exists: take the mark away
    // and a queued message is byte-for-byte the message it becomes. Anything
    // else that differed inside the pill would be something that MOVES when the
    // agent picks the message up, which is the jump this was built to stop.
    //
    // Scoped to the pill on purpose. Across the whole list `busy` also lights
    // the working dots and puts `is-queued` on the article — the first lives in
    // a slot held open whether it draws or not (`.dots-slot`) and the second is
    // an opacity, so neither is layout and neither belongs in this comparison.
    const body = (html: string) =>
      html.slice(html.indexOf('<div class="msg-body">'), html.indexOf('<div class="msg-foot"'));

    const queued = body(draw(true));
    const mark = queued.slice(queued.indexOf('<span class="queued"'));
    const onlyMark = mark.slice(0, mark.indexOf("</span>") + "</span>".length);

    expect(onlyMark).not.toBe("");
    expect(queued.replace(onlyMark, "")).toBe(body(draw(false)));
  });

  it("offers the way out in the clock's own corner, not beside it", () => {
    // The gutter is a fixed 40px whether anything is drawn in it or not, so a
    // second mark would have had to come from somewhere else on the pill. One
    // slot, two faces — and the button IS `.queued`, which is what keeps it
    // absolutely positioned and out of the words' way.
    const html = renderToStaticMarkup(
      <MessageList
        messages={[{ ...sent[0], turnId: "u-1" }]}
        busy
        onCancelQueued={() => {}}
      />,
    );

    expect(html).toContain('class="queued queued-cancel"');
    expect(html).toContain('aria-label="Cancel this queued message"');
    // Both faces live inside the one button, which lives inside the pill.
    expect(html).toMatch(
      /class="msg-body">[\s\S]*<button[^>]*class="queued queued-cancel"[\s\S]*queued-waiting[\s\S]*queued-take-back[\s\S]*<\/button>/,
    );
  });

  it("keeps the plain clock on a turn nothing can name", () => {
    // A turn sent before the id existed, or one an agent sent on its own
    // behalf, has nothing to address a cancel to. Better the mark it has always
    // had than a button that would answer a click with an error.
    const withHandler = renderToStaticMarkup(
      <MessageList messages={sent} busy onCancelQueued={() => {}} />,
    );
    const withId = renderToStaticMarkup(
      <MessageList messages={[{ ...sent[0], turnId: "u-1" }]} busy />,
    );

    expect(withHandler).not.toContain("queued-cancel");
    expect(withHandler).toContain('class="queued"');
    expect(withId).not.toContain("queued-cancel");
    expect(withId).toContain('class="queued"');
  });

  it("takes the way out away the moment the agent picks the message up", () => {
    // The ✕ is only ever offered while the message is still OURS to hold. Once
    // the agent has it there is nothing to cancel, and a button that stayed
    // would promise something no backend could do.
    const working = reduceChat(addUserTurn(emptyChat(), "do the thing", [], 1, undefined, "u-1"), {
      type: "turn.started",
    });
    const html = renderToStaticMarkup(
      <MessageList messages={working.messages} busy={working.busy} onCancelQueued={() => {}} />,
    );

    expect(html).not.toContain("queued-cancel");
  });

  it("keeps each Codex follow-up separate so only the waiting one has a clock", () => {
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
    ];
    const html = renderToStaticMarkup(
      <MessageList messages={messages} busy />,
    );

    expect(html.match(/class="msg msg-user/g)).toHaveLength(2);
    expect(html.match(/class="queued"/g)).toHaveLength(1);
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
