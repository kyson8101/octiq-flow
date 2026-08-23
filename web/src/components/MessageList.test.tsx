import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The bubble's attachment strip talks to the server, and that module opens the
// socket the moment it is imported — which there is no point doing to render
// some markup. Nothing here sends a file.
vi.mock("./Thumb", () => ({ SentFiles: () => null }));
// Same for the socket itself, which a reply's clickable paths now reach
// through to ask whether a file exists. Rendered on the server, none of them
// gets as far as asking.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
// Which paths "exist", for the tests below. The real store answers over the
// socket and only after an effect has run, neither of which a server render
// does — so the answers are put in by hand.
const resolved = vi.hoisted(() => new Map<string, string>());
vi.mock("../lib/pathStore", () => ({
  knownPath: (raw: string) => resolved.get(raw),
  askPaths: () => {},
  subscribePaths: () => () => {},
}));
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

describe("a file path in a reply", () => {
  const replied = (text: string): Message => ({
    id: "a1",
    role: "assistant",
    blocks: [{ kind: "text", text }],
    streaming: false,
  });

  const reply = (text: string) =>
    renderToStaticMarkup(<MessageList messages={[replied(text)]} busy={false} />);

  it("is marked, and the marker is a component rather than a stray tag", () => {
    const html = reply("I changed web/src/lib/files.ts today");

    // The plugin's marker element must never reach the page. Seeing it here
    // would mean react-markdown rendered the tag name instead of ProsePath.
    expect(html).not.toContain("octiq-path");
    expect(html).toContain("web/src/lib/files.ts");
  });

  it("stays plain words until the backend says the file exists", () => {
    // A path nothing has resolved is still only a guess, and a guess must not
    // look clickable.
    expect(reply("look at nowhere/gone.rs")).not.toContain("prose-path");
  });

  it("becomes something to click once it has", () => {
    resolved.set("src/main.rs", "/repo/src/main.rs");
    const html = reply("look at src/main.rs");

    expect(html).toContain("prose-path");
    expect(html).toContain("/repo/src/main.rs");
    resolved.clear();
  });

  it("keeps a path written in backticks looking like code", () => {
    resolved.set("web/src/App.tsx", "/repo/web/src/App.tsx");
    expect(reply("see `web/src/App.tsx`")).toContain("prose-path is-code");
    resolved.clear();
  });
});
