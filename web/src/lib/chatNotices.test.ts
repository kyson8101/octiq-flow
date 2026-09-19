import { describe, expect, it } from "vitest";
import { presentNotice, presentNotices } from "./chatNotices";

describe("chat notice presentation", () => {
  it("turns the noisy Codex diagnostics into useful human summaries", () => {
    expect(presentNotice(
      "2026-09-14T18:14:29.286752Z ERROR codex_core::tools::router: error=collab spawn failed: agent thread limit reached",
    )).toMatchObject({
      key: "agent-thread-limit",
      title: "A background agent could not start",
    });

    expect(presentNotice(
      "2026-09-14T19:09:29.878022Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 504 Gateway Timeout",
    )).toMatchObject({
      key: "codex-connection-timeout",
      title: "The Codex connection timed out",
    });

  });

  it("groups repeated diagnostics while retaining the latest technical record", () => {
    const notices = presentNotices([
      "2026-09-14T18:14:29Z ERROR codex_core::tools::router: error=collab spawn failed: agent thread limit reached",
      "2026-09-14T18:15:30Z ERROR codex_core::tools::router: error=collab spawn failed: agent thread limit reached",
    ]);

    expect(notices).toHaveLength(1);
    expect(notices[0].count).toBe(2);
    expect(notices[0].technical).toContain("18:15:30Z");
  });

  it("keeps plain guidance readable without inventing technical details", () => {
    expect(presentNotice("Say something first — a round uses your last message.")).toEqual({
      key: "message:say something first — a round uses your last message.",
      title: "Say something first — a round uses your last message.",
    });
  });
});
