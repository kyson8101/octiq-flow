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

describe("conversation pin return points", () => {
  it("marks every rendered turn as a stable destination for a pinned passage", () => {
    const html = render(said("keep this decision"));

    expect(html).toContain('data-pin-turn="u0"');
  });
});

describe("copying a message of your own", () => {
  it("offers a copy, the same one a reply has", () => {
    const html = render(said("what does this do?"));

    expect(html).toContain("msg-copy");
    expect(html).toContain("Copy this message");
  });

  it("still offers it on a message too long to be shown whole", () => {
    // The button takes the WHOLE message, not the head the bubble is cut to,
    // which is the case a copy is worth most: a pasted log you cannot select.
    const html = render(said(json));

    expect(html).toContain("show more");
    expect(html).toContain("msg-copy");
  });

  it("sits under the bubble rather than inside it", () => {
    // Inside the tinted bubble it reads as part of what you said. The bubble
    // is .msg-body, so the row has to come after that element has closed.
    const html = render(said("what does this do?"));
    const bubble = html.indexOf('class="msg-body"');
    const foot = html.indexOf('class="msg-foot"');

    expect(bubble).toBeGreaterThan(-1);
    expect(foot).toBeGreaterThan(-1);
    expect(html.slice(bubble, foot)).toContain("</div>");
  });

  it("says nothing to copy when there are no words to take", () => {
    expect(render(said(""))).not.toContain("msg-copy");
  });
});

describe("the working dots", () => {
  const at = (busy: boolean) =>
    renderToStaticMarkup(<MessageList messages={[said("read that file")]} busy={busy} />);

  it("do not sit at the foot of the transcript, busy or not", () => {
    // The status line above the composer says "still going" already, with the
    // time and the token count attached. A second pulse a few pixels under it
    // was the same news twice, and it is the half with less to say.
    expect(at(true)).not.toContain('aria-label="working"');
    expect(at(false)).not.toContain('aria-label="working"');
  });

  it("take no row with them, so the transcript cannot jump", () => {
    // The slot existed to stop the transcript stepping as the dots came and
    // went once per tool call. Nothing comes or goes there now.
    expect(at(true)).not.toContain("dots-slot");
    expect(at(false)).not.toContain("dots-slot");
  });

  it("still fill a streaming bubble that has arrived empty", () => {
    // The one place they are not redundant: a bubble that exists with nothing
    // in it yet. This never overlapped the foot-of-transcript pair — that one
    // required no message to be streaming at all.
    const opening: Message = { id: "a0", role: "assistant", blocks: [], streaming: true };
    expect(renderToStaticMarkup(<MessageList messages={[opening]} busy />)).toContain(
      'aria-label="working"',
    );
  });
});

describe("a Task card", () => {
  const started: Message = {
    id: "a-task",
    role: "assistant",
    blocks: [
      {
        kind: "tool",
        id: "tool-task",
        name: "Task",
        argsJson: "",
        args: { description: "Review the change" },
        state: "done",
      },
    ],
    streaming: false,
  };

  it("opens its matching read-only agent run instead of an inline transcript", () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[started]}
        busy={false}
        agentByTool={new Map([["tool-task", "agent-run"]])}
        onOpenAgent={() => {}}
      />,
    );

    expect(html).toContain('aria-label="Open read-only agent chat"');
    expect(html).not.toContain("tool-agent");
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

describe("a table in a reply", () => {
  const replied = (text: string): Message => ({
    id: "a1",
    role: "assistant",
    blocks: [{ kind: "text", text }],
    streaming: false,
  });

  const reply = (text: string) =>
    renderToStaticMarkup(<MessageList messages={[replied(text)]} busy={false} />);

  const table = [
    "| file | lines | why |",
    "| --- | ---: | --- |",
    "| styles.css | 5020 | the whole look |",
    "| pty.rs | 900 | the bridge |",
  ].join("\n");

  it("sits in a box of its own, so a wide one can be scrolled to", () => {
    // The transcript scrolls one way only — `.msgs` is `overflow-x: hidden` —
    // so a table wider than the column is simply CUT unless it brings its own
    // sideways scroll. This wrapper is what brings it.
    const html = reply(table);
    const box = html.indexOf("prose-table");

    expect(box).toBeGreaterThan(-1);
    expect(html.indexOf("<table")).toBeGreaterThan(box);
  });

  it("keeps the alignment the markdown asked for", () => {
    // `---:` is how an agent says "this column is numbers". Losing it puts a
    // column of figures back on the left, where they no longer line up.
    expect(reply(table)).toContain("text-align:right");
  });
});
