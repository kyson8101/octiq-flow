import { expect, it } from "vitest";
import { addUserTurn, emptyChat, type Message } from "./chat";
import { chatPreviewState, hasLocalPrompt, withLocalPrompts } from "./chatRetention";

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

it.each(["sending", "queued", "failed", "unknown"] as const)("keeps the entire local %s prompt through release and an empty or stale row seed", delivery => {
  const state = addUserTurn(emptyChat(), "local words".repeat(1000), [], 10, "local");
  const prompt = { ...state.messages[0], delivery, queueLost: delivery === "failed", queueError: "feedback",
    attachments: [{ path: "/fixture/image.png", name: "image.png", isImage: true }] };
  state.messages = [prompt];
  const released = chatPreviewState(state);
  expect(released.messages).toEqual([prompt]);
  expect(hasLocalPrompt(released)).toBe(true);
  expect(withLocalPrompts(emptyChat(), released, true).messages[0]).toBe(prompt);
  const stale = { ...state, messages: [{ ...prompt, delivery: "sending" as const, attachments: [] }] };
  expect(withLocalPrompts(stale, released, true).messages[0]).toBe(prompt);
  const confirmed = { ...state, messages: [{ ...prompt, takenUp: true }] };
  expect(withLocalPrompts(confirmed, released, true).messages[0].takenUp).toBe(true);
});

it("does not turn subagent output into the main chat's response preview", () => {
  const state = emptyChat();
  state.messages = [{ id: "main", role: "assistant", streaming: false, blocks: [{ kind: "text", text: "main" }] },
    { id: "child", role: "assistant", parent: "tool", streaming: false, blocks: [{ kind: "text", text: "child" }] }];
  expect(chatPreviewState(state).messages.map(message => message.id)).toEqual(["main"]);
});
