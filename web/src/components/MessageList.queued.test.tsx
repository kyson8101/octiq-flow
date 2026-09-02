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
      <MessageList messages={messages} busy hostAgent="codex" />,
    );

    expect(html.match(/class="msg msg-user/g)).toHaveLength(2);
    expect(html.match(/class="queued"/g)).toHaveLength(1);
  });

  it("does not change Claude's existing consecutive-message grouping", () => {
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
    const html = renderToStaticMarkup(
      <MessageList messages={messages} busy={false} hostAgent="claude" />,
    );

    expect(html.match(/class="msg msg-user/g)).toHaveLength(1);
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
      <MessageList messages={messages} busy hostAgent="codex" />,
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
      <MessageList messages={messages} busy={false} hostAgent="codex" />,
    );

    expect(html.match(/class="msg msg-assistant/g)).toHaveLength(2);
    expect(html.match(/class="msg-reply-label"/g)).toHaveLength(2);
  });
});
