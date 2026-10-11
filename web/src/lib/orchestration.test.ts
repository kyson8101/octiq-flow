import { describe, expect, it } from "vitest";

import { isPeerRequestGate } from "./orchestration";

describe("isPeerRequestGate", () => {
  const peerRequest = {
    requestedBy: { id: "ada", name: "ADA" },
    requesterChatKey: "chat:lead",
    output: "One line per volume.",
    maxMinutes: 30,
    requestedAt: 1,
  };
  const tasks = [{ id: "task_peer", peerRequest }, { id: "task_plain" }];

  it("is a gate on a task a teammate asked for, and no other", () => {
    expect(isPeerRequestGate({ taskId: "task_peer" }, tasks)).toBe(true);
    expect(isPeerRequestGate({ taskId: "task_plain" }, tasks)).toBe(false);
    // A run's own gate names no task; a task the page has not read is not assumed to be one.
    expect(isPeerRequestGate({}, tasks)).toBe(false);
    expect(isPeerRequestGate({ taskId: "task_gone" }, tasks)).toBe(false);
  });
});
