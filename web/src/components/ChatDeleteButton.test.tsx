import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatDeleteButton } from "./ChatDeleteButton";

describe("the chat top-bar delete button", () => {
  it("offers to delete the open chat", () => {
    const out = renderToStaticMarkup(
      <ChatDeleteButton deleting={false} deleteMs={2000} onDelete={() => {}} />,
    );

    expect(out).toContain('aria-label="Delete this chat"');
    expect(out).toContain("topbar-delete");
    expect(out).not.toContain("chat-drain-arc");
  });

  it("becomes the undo control during the delete countdown", () => {
    const out = renderToStaticMarkup(
      <ChatDeleteButton deleting deleteMs={4200} onDelete={() => {}} />,
    );

    expect(out).toContain('aria-label="Cancel delete"');
    expect(out).toContain("is-going");
    expect(out).toContain("chat-drain-arc");
    expect(out).toContain("4200ms");
  });

  it("cannot be pressed after the delete commits", () => {
    const out = renderToStaticMarkup(
      <ChatDeleteButton deleting={false} disabled deleteMs={2000} onDelete={() => {}} />,
    );

    expect(out).toContain('disabled=""');
  });
});
