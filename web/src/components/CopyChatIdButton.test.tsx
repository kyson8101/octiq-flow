import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyChatIdButton } from "./CopyChatIdButton";

describe("the chat ID copy action", () => {
  it("is named and available wherever chat actions are rendered", () => {
    const out = renderToStaticMarkup(<CopyChatIdButton chatId="chat-123" />);
    expect(out).toContain('aria-label="Copy chat ID"');
    expect(out).toContain("copy-chat-id");
    expect(out).toContain("Copy chat ID");
  });
});
