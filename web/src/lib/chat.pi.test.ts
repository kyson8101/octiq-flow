import { describe, expect, it } from "vitest";

import { emptyChat, reduceChat } from "./chat";

describe("pi.dev conversations", () => {
  it("claims the queued prompt, streams an answer and completes tools", () => {
    let state = reduceChat(emptyChat(), {
      type: "user",
      uuid: "turn-1",
      octiq_user_turn: true,
      message: { role: "user", content: [{ type: "text", text: "inspect this" }] },
    });
    state = reduceChat(state, { type: "session", id: "pi-session", cwd: "/repo" });
    state = reduceChat(state, { type: "turn_start", octiq_user_turn_id: "turn-1" }, 1000);
    state = reduceChat(state, {
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking. " },
    });
    state = reduceChat(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Found it." },
    });
    state = reduceChat(state, {
      type: "message_end",
      message: {
        role: "assistant",
        model: "gpt-5.6-terra",
        stopReason: "toolUse",
        usage: { input: 20, output: 5, cacheRead: 10, cacheWrite: 0 },
        content: [
          { type: "thinking", thinking: "Checking. " },
          { type: "text", text: "Found it." },
          { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
        ],
      },
    });
    state = reduceChat(state, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
      result: { content: [{ type: "text", text: "contents" }] },
      isError: false,
    });
    state = reduceChat(state, { type: "agent_end", messages: [], willRetry: false });
    expect(state.busy).toBe(true);
    state = reduceChat(state, { type: "agent_settled" });

    expect(state.sessionId).toBe("pi-session");
    expect(state.cwd).toBe("/repo");
    expect(state.model).toBe("gpt-5.6-terra");
    expect(state.contextTokens).toBe(35);
    expect(state.busy).toBe(false);
    expect(state.messages[0]).toMatchObject({ role: "user", takenUp: true });
    expect(state.messages[1].blocks).toEqual([
      { kind: "thinking", text: "Checking. " },
      { kind: "text", text: "Found it." },
      {
        kind: "tool",
        id: "pi:host:tool-1",
        name: "Read",
        args: { path: "README.md" },
        argsJson: '{"path":"README.md"}',
        result: "contents",
        state: "done",
      },
    ]);
  });

  it("turns a provider failure into the normal error banner", () => {
    const state = reduceChat(emptyChat(), {
      type: "message_end",
      message: {
        role: "assistant",
        model: "gpt-5.6-sol",
        stopReason: "error",
        errorMessage: "usage limit reached",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        content: [],
      },
    });

    expect(state.failure?.title).toBe("Your Codex account is out of credits");
    expect(state.busy).toBe(false);
  });
});
