import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The image branch fetches bytes over the socket, and that module opens the
// connection the moment it is imported. Nothing here asks for a file.
vi.mock("../lib/bridge", () => ({ bridge: { fetchFile: async () => new Blob() } }));
// CodeMirror is never rendered by the prose branch, but importing the real
// editor drags the whole package in for nothing.
vi.mock("./CodeEditor", () => ({ CodeEditor: () => null }));
import { FileView } from "./FileView";
import type { Preview } from "../lib/fileView";

const markdown = (content: string): Preview => ({
  kind: "text",
  content,
  truncated: false,
  size: content.length,
});

// `draft` is what the frames hand back in — the file view renders what is in
// the editor, not what came off disk, so the two are the same until you type.
const draw = (content: string) =>
  renderToStaticMarkup(
    <FileView
      path="/repo/CLAUDE.md"
      preview={markdown(content)}
      draft={content}
      onDraft={() => {}}
    />,
  );

describe("a markdown file, rendered", () => {
  const table = [
    "| 步 | 产物 | 谁写 | 走哪里 |",
    "| --- | --- | --- | --- |",
    "| 大纲 | `outline.md` | Codex | 过 `bible/seasons/README.md` 的四关 |",
    "| 稿 | `prose.md` | Claude | `/write-prose` 起初稿 → `/review-prose` 审 |",
  ].join("\n");

  it("puts a table in a box of its own, so a wide one can be scrolled to", () => {
    // A table is sized by its cells and cannot be made narrower than them, so
    // one wider than the pane used to stick out of it and be cut off at the
    // window edge with no way to reach the rest. Same box the transcript uses.
    const html = draw(table);
    const box = html.indexOf("prose-table");

    expect(box).toBeGreaterThan(-1);
    expect(html.indexOf("<table")).toBeGreaterThan(box);
  });

  it("still draws the file's own prose around it", () => {
    expect(draw("# Title\n\nA line.")).toContain("A line.");
  });

  it("sends a web link to a browser tab instead of navigating OctiqFlow", () => {
    const html = draw("Read [the docs](https://example.com/docs).");

    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });
});

describe("an html file, drawn as the page it is", () => {
  const page = (content: string): Preview => ({
    kind: "text",
    content,
    truncated: false,
    size: content.length,
  });

  const drawPage = (content: string, raw?: boolean) =>
    renderToStaticMarkup(
      <FileView
        path="/repo/report.html"
        preview={page(content)}
        draft={content}
        raw={raw}
        onDraft={() => {}}
      />,
    );

  const PAGE = "<h1>Hi</h1>";

  it("draws the markup in a frame instead of showing it as source", () => {
    const html = drawPage(PAGE);

    expect(html).toContain("<iframe");
    expect(html).toContain("&lt;h1&gt;Hi&lt;/h1&gt;");
  });

  it("keeps the page walled off from the app it is being read in", () => {
    // `allow-scripts` WITHOUT `allow-same-origin` is the whole point: a page an
    // agent wrote runs its own charts and toggles, but sits in an origin of its
    // own, so it can never reach this app's token or storage. The two together
    // would hand it both.
    const html = drawPage(PAGE);

    expect(html).toMatch(/sandbox="[^"]*allow-scripts/);
    expect(html).not.toContain("allow-same-origin");
  });

  it("goes back to the editor when the frame asks for source", () => {
    expect(drawPage(PAGE, true)).not.toContain("<iframe");
  });
});
