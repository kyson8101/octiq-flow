// The CLI's settings list, drawn as settings.
//
// Its own file, the way the notice and room cases have theirs — this is one
// piece of work, and `MessageList.test.tsx` belongs to another.
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

/** Trimmed from the real answer in `__fixtures__/config-command.jsonl`. */
const USAGE = `Usage: /config key=value [key=value ...]
  editor=normal|vim
  language=<value>
  theme=auto|dark|light
  verbose=true|false`;

const said = (text: string, id = "m1"): Message => ({
  id,
  role: "assistant",
  blocks: [{ kind: "text", text }],
  streaming: false,
});

const render = (...messages: Message[]) =>
  renderToStaticMarkup(<MessageList messages={messages} busy={false} />);

describe("the answer to a bare /config", () => {
  it("is drawn as rows of settings, not as the text it arrived as", () => {
    const html = render(said(USAGE));

    expect(html).toContain("cfg-row");
    // The `key=a|b|c` line itself is gone — that is the whole point.
    expect(html).not.toContain("verbose=true|false");
  });

  it("names each setting the way a person would, and keeps the key", () => {
    const html = render(said(USAGE));

    expect(html).toContain("Verbose");
    expect(html).toContain("editor");
  });

  it("offers every value the CLI listed, as the line it would send", () => {
    const html = render(said(USAGE));

    expect(html).toContain("/config editor=vim");
    expect(html).toContain("/config theme=dark");
  });

  it("gives a free-text setting no buttons to press", () => {
    const html = render(said(USAGE));

    // `language=<value>` takes anything, so there is nothing to offer.
    expect(html).not.toContain("/config language=&lt;value&gt;");
    expect(html).toContain("/config language=…");
  });

  it("marks the value the CLI has confirmed in this chat", () => {
    const html = render(said(USAGE), said("Set Verbose output to true", "m2"));

    expect(html).toContain("cfg-opt is-on");
    expect(html).toContain('aria-pressed="true"');
  });

  it("marks nothing when nothing has been confirmed", () => {
    const html = render(said(USAGE));

    expect(html).not.toContain("cfg-opt is-on");
  });

  it("leaves an ordinary reply alone", () => {
    const html = render(said("Here is what `/config key=value` does."));

    expect(html).not.toContain("cfg-row");
    expect(html).toContain("/config key=value");
  });
});
