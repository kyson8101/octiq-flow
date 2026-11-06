import { expect, it } from "vitest";
import { addUserTurn, emptyChat, type Message } from "./chat";
import { chatPreviewState, hasLocalPrompt } from "./chatRetention";

it("bounds background transcript content even when a single tool result or answer is huge", () => {
  const state = emptyChat();
  state.busy = true;
  state.sessionId = "resume-here";
  state.messages = Array.from({ length: 30 }, (_, i): Message => ({
    id: `m${i}`, role: "assistant", streaming: false,
    blocks: [{ kind: "text", text: "answer".repeat(100_000) },
      { kind: "tool", id: `t${i}`, name: "Read", state: "done", argsJson: "huge", args: {}, result: "x".repeat(1_000_000) }],
    progress: ["x".repeat(1_000_000)],
  }));
  const preview = chatPreviewState(state);
  expect(preview.messages.map(message => message.id)).toEqual(["m27", "m28", "m29"]);
  expect(JSON.stringify(preview.messages).length).toBeLessThan(2_000);
  expect(preview).toMatchObject({ busy: true, sessionId: "resume-here", agents: [], background: [] });
  expect(state.messages).toHaveLength(30);
});

it("never shortens an unacknowledged prompt, attachments or queue feedback", () => {
  const state = addUserTurn(emptyChat(), "local words".repeat(100_000), [], 10, "local");
  const pending = state.messages[0];
  expect(hasLocalPrompt(state)).toBe(true);
  expect(chatPreviewState(state).messages[0]).toBe(pending);
  expect(hasLocalPrompt({ ...state, messages: [{ ...pending, echo: "host-echo" }] })).toBe(false);
  expect(hasLocalPrompt({ ...state, messages: [{ ...pending, takenUp: true }] })).toBe(false);
});

it("does not turn subagent output into the main chat's response preview", () => {
  const state = emptyChat();
  state.messages = [{ id: "main", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "main" }] },
    { id: "child", role: "assistant", parent: "tool", streaming: false, blocks: [{ kind: "text", text: "child" }] }];
  expect(chatPreviewState(state).messages.map(message => message.id)).toEqual(["main"]);
});
