import { describe, expect, it } from "vitest";

import { readPiEvent } from "./piEvents";

describe("pi.dev JSON events", () => {
  it("reads session identity and streaming prose", () => {
    expect(readPiEvent({ type: "session", id: "pi-123", cwd: "/repo" })).toEqual({
      kind: "session",
      id: "pi-123",
      cwd: "/repo",
    });
    expect(
      readPiEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
      }),
    ).toEqual({ kind: "delta", block: "text", text: "hello" });
  });

  it("keeps the authoritative Codex model and tool calls from a message", () => {
    expect(
      readPiEvent({
        type: "message_end",
        message: {
          role: "assistant",
          model: "gpt-5.6-terra",
          stopReason: "toolUse",
          usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 0 },
          content: [
            { type: "thinking", thinking: "checking" },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
          ],
        },
      }),
    ).toEqual({
      kind: "message",
      content: [
        { kind: "thinking", text: "checking" },
        { kind: "tool", id: "call-1", name: "bash", args: { command: "pwd" } },
      ],
      model: "gpt-5.6-terra",
      usage: { input: 10, output: 2, cacheRead: 5, cacheWrite: 0 },
      aborted: false,
    });
  });

  it("pairs tool execution and reports its result", () => {
    expect(
      readPiEvent({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "pwd" },
        result: { content: [{ type: "text", text: "/repo" }], details: { exitCode: 0 } },
        isError: false,
      }),
    ).toEqual({
      kind: "tool",
      id: "call-1",
      name: "bash",
      args: { command: "pwd" },
      state: "done",
      result: "/repo",
      details: { exitCode: 0 },
    });
  });

  it("reads whose failure an error result was from the bridge's `_meta`", () => {
    const outcome = { origin: "octiqflow", reasonClass: "approval-expired", severity: "warning" };
    const read = readPiEvent({
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "mcp__octiq__request_access",
      args: {},
      result: {
        content: [{ type: "text", text: "The approval expired." }],
        details: { _meta: { "octiq/outcome": outcome } },
      },
      isError: true,
    });
    expect(read).toMatchObject({ kind: "tool", state: "error", result: "The approval expired.", outcome });
    // A success never carries one, and an error with no meta is drawn as before.
    expect(
      readPiEvent({
        type: "tool_execution_end",
        toolCallId: "call-3",
        toolName: "x",
        result: { content: [], details: { _meta: { "octiq/outcome": outcome } } },
        isError: false,
      }),
    ).not.toHaveProperty("outcome");
    expect(
      readPiEvent({
        type: "tool_execution_end",
        toolCallId: "call-4",
        toolName: "x",
        result: { content: [{ type: "text", text: "no" }], details: {} },
        isError: true,
      }),
    ).not.toHaveProperty("outcome");
  });

  it("waits for Pi to settle without breaking legacy agent-end streams", () => {
    expect(readPiEvent({ type: "agent_end", messages: [], willRetry: false })).toBeNull();
    expect(readPiEvent({ type: "agent_end", messages: [], willRetry: true })).toBeNull();
    expect(readPiEvent({ type: "agent_settled" })).toEqual({ kind: "done" });
    expect(readPiEvent({ type: "agent_end", messages: [] })).toEqual({ kind: "done" });
  });
});
