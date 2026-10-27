import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [], fetchFile: vi.fn(), fileUrl: (p: string) => p } }));
vi.mock("../lib/pathStore", () => ({ knownPath: () => undefined, askPaths: () => {}, subscribePaths: () => () => {} }));
import sheetRaw from "./MediaBesideText.css?raw";
import sourceRaw from "./MediaBesideText.tsx?raw";
import { MediaPending, MediaReply } from "./MediaBesideText";
import { MessageList } from "./MessageList";
import type { Message } from "../lib/chat";
import { mediaBlock } from "../lib/mediaBlock";

import { lf } from "../lib/sourceText";
const sheet = lf(sheetRaw);
const source = lf(sourceRaw);

const data = { path: "/abs/a.png", title: "A useful picture", text: "What this means", caption: "One view" };
const fenced = (body: string) => "```octiq-media\n" + body + "\n```";
const render = (text: string) => renderToStaticMarkup(<MessageList messages={[{ id: "m", role: "assistant", streaming: false, blocks: [{ kind: "text", text }] } satisfies Message]} busy={false} />);

describe("a media reply", () => {
  it("replaces the code block with a labelled card and one named figure", () => {
    const html = render(`Before.\n\n${fenced(JSON.stringify(data))}\n\nAfter.`);
    expect(html).toContain('class="media-reply" aria-labelledby=');
    expect(html).toContain('class="media-beside"');
    expect(html.match(/<figure /g)).toHaveLength(1);
    expect(html).toContain("<figcaption");
    for (const text of [data.title, data.text, data.caption, "a.png"]) expect(html).toContain(text);
    expect(html).not.toContain('class="code"');
    expect(html).not.toContain("<img"); // no fetch before useNear
  });
  it.each(["a.mp4", "a.wav"])("reserves a %s player before it is near", (name) => {
    const html = render(fenced(JSON.stringify({ ...data, path: `/abs/${name}` })));
    expect(html).toContain(`qa-media-box is-${name.endsWith("mp4") ? "video" : "audio"}`);
    expect(html).not.toMatch(/<(video|audio)/);
  });
  it("draws strings as text, never HTML or markdown", () => {
    const html = render(fenced(JSON.stringify({ ...data, title: "<script>bad()</script>", text: "<img onerror=bad()> **words**", caption: "<b>caption</b>" })));
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).toContain("&lt;img onerror=bad()&gt; **words**");
    expect(html).not.toContain("<script>");
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });
  it("keeps invalid, oversized and unclosed blocks as ordinary code", () => {
    for (const text of [fenced("{}"), fenced(JSON.stringify([data])), fenced(JSON.stringify({ ...data, extra: "/a.png" })), "```octiq-media\n" + JSON.stringify(data)]) {
      const html = render(text);
      expect(html).toContain('class="code"');
      expect(html).not.toContain('class="media-reply"');
    }
  });
  it("also handles closed nested fences, without repairing an unclosed one", () => {
    expect(render("- File:\n\n  " + fenced(JSON.stringify(data)).replaceAll("\n", "\n  "))).toContain('class="media-reply"');
    expect(render("- File:\n\n  ```octiq-media\n  " + JSON.stringify(data))).toContain('class="code"');
  });
  it("holds the exact final markup unseen before closing, without a player or fetch", () => {
    const drawn = mediaBlock("```octiq-media\n" + JSON.stringify(data), true);
    expect(drawn?.kind).toBe("pending");
    if (drawn?.kind !== "pending" || !drawn.media) throw Error("missing reservation");
    const html = renderToStaticMarkup(<MediaPending media={drawn.media} />);
    const reserved = renderToStaticMarkup(<MediaReply reserveOnly media={drawn.media} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('class="media-ghost" aria-hidden="true" inert=""');
    // useId differs by tree position; the content and structure do not.
    expect(html.replace(/_R_[^"]+_/g, "ID")).toContain(reserved.replace(/_R_[^"]+_/g, "ID"));
    expect(html).not.toMatch(/<(button|img|video|audio)/);
    expect(html).toContain("Preparing media…");
  });
});

describe("the shared layout", () => {
  it("responds to block width and reserves the same box for loading, failure and every kind", () => {
    expect(sheet).toMatch(/container-type: inline-size/);
    expect(sheet).toMatch(/@container \(width < 480px\)/);
    expect(sheet).not.toMatch(/@media/);
    expect(sheet).toMatch(/\.media-beside-file \.qa-media-box \{[^}]*height: 144px;/);
    expect(sheet).toMatch(/\.media-ghost \{ visibility: hidden; \}/);
  });
  it("has only neutral tokens and no shadow", () => {
    expect(sheet).toContain("border: 1px solid var(--border)");
    expect(sheet).toContain("background: var(--bg-1)");
    expect(sheet).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|--accent|--decide|box-shadow/);
  });
});
