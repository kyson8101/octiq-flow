import { describe, expect, it } from "vitest";
import { noticesHeadline, presentNotice, presentNotices } from "./chatNotices";

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

  it("says interrupted background tasks as a count, and keeps the host's sentence for the panel", () => {
    const one = "1 background task(s) interrupted when the provider process ended: bz8nya9u6. Retained output may contain partial work; verify it before retrying.";
    const three = "3 background task(s) interrupted when the provider process ended: a1, b2, c3. Retained output may contain partial work; verify it before retrying.";
    expect(presentNotice(one)).toEqual({
      key: "background-interrupted:bz8nya9u6",
      title: "1 background task interrupted",
      detail: one,
    });
    expect(presentNotice(three).title).toBe("3 background tasks interrupted");
    // The ids are in the sentence the panel shows, never on the row.
    expect(presentNotice(three).title).not.toContain("a1");
    expect(presentNotice(three).detail).toContain("a1, b2, c3");
    // Two interruptions are two notices: different tasks were lost.
    expect(presentNotices([one, three])).toHaveLength(2);
  });

  it("says one short title folded, or how many notices there are", () => {
    const one = "1 background task(s) interrupted when the provider process ended: bz8nya9u6. Retained output may contain partial work; verify it before retrying.";
    const log = "2026-09-14T18:14:29Z ERROR codex_core::tools::router: error=collab spawn failed: agent thread limit reached";
    expect(noticesHeadline(presentNotices([one]), 1)).toBe("1 background task interrupted");
    expect(noticesHeadline(presentNotices([one, log, log]), 3)).toBe("3 notices");
    // The same diagnostic twice is still two notices.
    expect(noticesHeadline(presentNotices([log, log]), 2)).toBe("2 notices");
    expect(noticesHeadline([], 0)).toBe("");
  });

  it("never titles a long sentence with a slice of it", () => {
    const why = "Could not switch models: the provider process did not stop within the time the host allows for a model change, so the chat keeps the model it had.";
    expect(presentNotice(why)).toMatchObject({ title: "Could not switch models", detail: why });
    const plain = "The provider process did not stop within the time the host allows for a model change and so the chat keeps the model it had before.";
    expect(presentNotice(plain)).toMatchObject({ title: "Notice", detail: plain });
    for (const text of [why, plain]) expect(presentNotice(text).title.length).toBeLessThanOrEqual(60);
  });

  it("keeps plain guidance readable without inventing technical details", () => {
    expect(presentNotice("Say something first — a round uses your last message.")).toEqual({
      key: "message:say something first — a round uses your last message.",
      title: "Say something first — a round uses your last message.",
    });
  });
});
