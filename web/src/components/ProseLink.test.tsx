import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProseLink } from "./ProseLink";

/** The chat's own markdown setup, minus the parts a link does not care about. */
const render = (md: string) =>
  renderToStaticMarkup(
    <Markdown remarkPlugins={[remarkGfm]} components={{ a: ProseLink }}>
      {md}
    </Markdown>,
  );

describe("ProseLink", () => {
  it("sends a written link to a new tab", () => {
    const html = render("See [the docs](https://example.com/docs) for more.");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("sends a bare url to a new tab too", () => {
    const html = render("Bare: https://example.com/bare");
    expect(html).toContain('href="https://example.com/bare"');
    expect(html).toContain('target="_blank"');
  });

  it("keeps the title a link came with", () => {
    const html = render('[docs](https://example.com "the docs")');
    expect(html).toContain('title="the docs"');
  });

  // react-markdown empties the href of a scheme it will not vouch for. A new
  // tab onto ourselves is worse than plain text, so it stops being a link.
  it("draws a link with no href as plain text", () => {
    const html = render("[the file](file:///Users/kyson/x.png)");
    expect(html).not.toContain("<a");
    expect(html).toContain("the file");
  });

  // react-markdown hands every custom component a `node`; it is not an
  // attribute and must never reach the DOM.
  it("does not leak the hast node onto the anchor", () => {
    expect(render("[x](https://example.com)")).not.toContain("node=");
  });
});
