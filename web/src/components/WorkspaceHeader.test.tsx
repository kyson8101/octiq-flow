import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceHeader } from "./WorkspaceHeader";

describe("WorkspaceHeader", () => {
  it("draws a row of its own where no top bar is offered", () => {
    const out = renderToStaticMarkup(
      <WorkspaceHeader root back={{ label: "Chat", ariaLabel: "Back to chat", onClick: () => {} }}
        title={<h1>Search chats</h1>}
        actions={<button type="button">New project</button>} />,
    );
    expect(out).toContain('class="workspace-header"');
    expect(out).toContain('class="workspace-back is-root"');
    expect(out).toContain('aria-label="Back to chat"');
    expect(out).toContain("<h1>Search chats</h1>");
    // The way back, then the title, then the page's actions — reading order.
    expect(out.indexOf("Back to chat")).toBeLessThan(out.indexOf("Search chats"));
    expect(out.indexOf("Search chats")).toBeLessThan(out.indexOf("New project"));
  });

  it("names the way back after its destination when no label is given", () => {
    const out = renderToStaticMarkup(
      <WorkspaceHeader back={{ label: "Projects", onClick: () => {} }} title={<h1>octiq-flow</h1>} />,
    );
    expect(out).toContain('aria-label="Back to Projects"');
    expect(out).not.toContain("is-root");
    expect(out).not.toContain("workspace-actions");
  });
});
