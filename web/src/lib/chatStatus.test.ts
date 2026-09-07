import { describe, expect, it } from "vitest";
import { isInternalCodexToolRecovery, shouldShowChatStatus } from "./chatStatus";

describe("chat status visibility", () => {
  it("keeps Codex's non-actionable missing-tool-output recovery in diagnostics", () => {
    const text = "2026-09-07T06:14:14.818956Z ERROR codex_core::util: Custom tool call output is missing for call id: call_CbLzI22sSJjAXpJ5ttjxlJ0x";

    expect(isInternalCodexToolRecovery(text)).toBe(true);
    expect(shouldShowChatStatus("stderr", text)).toBe(false);
  });

  it("leaves real errors and process exits alone", () => {
    expect(shouldShowChatStatus("stderr", "Error loading config.toml")).toBe(true);
    expect(shouldShowChatStatus("exit", "")).toBe(true);
  });
});
