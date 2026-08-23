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

  it("draws the picture itself when the file is one", () => {
    resolved.set("bible/ref.png", "/repo/bible/ref.png");
    const html = reply("got it: bible/ref.png");

    // The name stays a link, and the picture goes under it.
    expect(html).toContain("prose-path");
    expect(html).toContain("prose-shot");
    resolved.clear();
  });

  it("cuts a picture's path down to its name, keeping the rest in reach", () => {
    const full = "/Users/kyson/lab/starfall-variants-archive/characters/aria-roster-v1-cut.png";
    resolved.set(full, full);
    const html = reply(`3 张随机 PNG: ${full}`);

    // Four centred lines of folders, for a file the reader can see.
    expect(html).toContain(">aria-roster-v1-cut.png<");
    expect(html).not.toContain(">/Users/kyson/lab/starfall-variants-archive");
    // Still the whole thing on a long press.
    expect(html).toContain(`title="${full}"`);
    resolved.clear();
  });

  it("leaves every other kind of file worded as the reply wrote it", () => {
    resolved.set("web/src/lib/files.ts", "/repo/web/src/lib/files.ts");
    expect(reply("I changed web/src/lib/files.ts")).toContain(">web/src/lib/files.ts<");
    resolved.clear();
  });

  it("draws no picture for a file that is not one", () => {
    resolved.set("src/main.rs", "/repo/src/main.rs");
    expect(reply("look at src/main.rs")).not.toContain("prose-shot");
    resolved.clear();
  });

  it("draws no picture for a name that turned out not to be a file", () => {
    expect(reply("something like screenshot.png would do")).not.toContain("prose-shot");
  });
});
