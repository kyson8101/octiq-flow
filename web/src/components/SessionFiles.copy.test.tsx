// The two buttons a pinned row carries beside the file.
//
// The column says which files matter. These two say where one IS and what is IN
// it, for the times the answer is wanted somewhere that is not this page — a
// terminal, another chat, a message to somebody.
//
// A node run sees static markup and no clipboard, so what is checked here is
// the wiring: that both buttons reach the page, that each says which one it is,
// and that a picture is offered only the one that means anything for it. The
// copy itself goes through `lib/clipboard`, which is where that half is tested.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The column reads files over the socket, and that module opens the connection
// the moment it is imported. Nothing here asks for a file — a static render
// never gets as far as the click that would.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => null } }));
import type { Pin } from "../lib/pins";
import { PinRow } from "./SessionFiles";

const row = (pin: Pin) =>
  renderToStaticMarkup(
    <ul>
      <PinRow pin={pin} modified={null} onOpen={() => {}} />
    </ul>,
  );

describe("a pinned row", () => {
  it("offers both the path and the contents", () => {
    const html = row({ path: "/repo/web/src/lib/chat.ts", why: "the reducer" });

    expect(html).toContain("Copy the path");
    expect(html).toContain("Copy what is in the file");
  });

  it("does not offer to copy a picture's text", () => {
    const html = row({ path: "/repo/brand/icon.png" });

    expect(html).toContain("Copy the path");
    expect(html).not.toContain("Copy what is in the file");
  });

  it("still draws the file, the label and the line the agent pinned", () => {
    const html = row({
      path: "/repo/web/src/lib/chat.ts",
      label: "the bug",
      why: "the reducer drops the last delta",
      line: 212,
    });

    expect(html).toContain("chat.ts");
    expect(html).toContain("the bug");
    expect(html).toContain("line 212");
  });

  it("keeps the buttons out of the row's own button", () => {
    // A button inside a button is dropped by the browser's parser, which would
    // take the copy controls off the page entirely. They are siblings, so the
    // row's button closes before either of them opens.
    const html = row({ path: "/repo/web/src/lib/chat.ts" });
    const rowButtonEnds = html.indexOf("</button>");
    const firstAction = html.indexOf("sfp-act");

    expect(rowButtonEnds).toBeGreaterThan(-1);
    expect(firstAction).toBeGreaterThan(rowButtonEnds);
  });
});
