import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The bubble's attachment strip talks to the server, and that module opens the
// socket the moment it is imported — which there is no point doing to render
// some markup. Nothing here sends a file.
vi.mock("./Thumb", () => ({ SentFiles: () => null }));
import type { Message } from "../lib/chat";
import { MessageList } from "./MessageList";

const said = (text: string): Message => ({
  id: "u0",
  role: "user",
  blocks: [{ kind: "text", text }],
  streaming: false,
});

const render = (...messages: Message[]) =>
  renderToStaticMarkup(<MessageList messages={messages} busy={false} />);

/** A pasted json, the case this exists for. */
const json = JSON.stringify(
  { items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `row ${i}` })) },
  null,
  2,
);

describe("a long message of your own", () => {
  it("is cut, with a way to see the rest", () => {
    const html = render(said(json));

    expect(html).toContain("show more");
    expect(html).not.toContain("row 39");
  });

  it("is cut on its own, not together with the message next to it", () => {
    const html = render(said(json), said(json));

    expect(html.match(/show more/g)).toHaveLength(2);
  });

  it("leaves a short message alone", () => {
    const html = render(said("what does this do?"));

    expect(html).toContain("what does this do?");
    expect(html).not.toContain("show more");
  });
});

describe("a turn the reader stopped", () => {
  const answered = (id: string, text: string): Message => ({
    id,
    role: "assistant",
    blocks: [{ kind: "text", text }],
    streaming: false,
  });

  const transcript = (stoppedAt?: string) =>
    renderToStaticMarkup(
      <MessageList
        messages={[{ ...said("read that file"), id: "u1" }, answered("a1", "Let me look at")]}
        busy={false}
        stoppedAt={stoppedAt}
      />,
    );

  it("draws the line the answer stops on, once, and says who stopped it", () => {
    const html = transcript("a1");

    expect(html).toContain("You stopped this");
    expect(html.match(/stopmark-label/g)).toHaveLength(1);
  });

  it("draws nothing at all when the turn ran to its own end", () => {
    expect(transcript()).not.toContain("stopmark");
  });
});
