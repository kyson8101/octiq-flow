import { describe, expect, it } from "vitest";
import { addUserTurn, emptyChat, reduceChat } from "./chat";

describe("recovery exit evidence", () => {
  it("records a provider handoff without keeping the old native session or quota failure", () => {
    const event = { type: "octiq_provider_switched", agent: "codex", model: "gpt-5.6-sol", session_id: "new-codex", message: "Continuing with Codex" };
    const before = { ...emptyChat(), sessionId: "old-claude" };
    const after = reduceChat(before, event);
    expect(after.sessionId).toBe("new-codex");
    expect(after.model).toBe("gpt-5.6-sol");
    expect(after.failure).toBeUndefined();
    expect(reduceChat(after, event).notices).toEqual(["Continuing with Codex"]);
  });
  const crashed = () => ({ ...emptyChat(), exited: { code: 1 } });
  it("clears the prior exit when the user resumes the host", () => {
    expect(addUserTurn(crashed(), "Continue").exited).toBeUndefined();
  });
  it("clears the prior exit when another client starts a Codex host turn", () => {
    expect(reduceChat(crashed(), { type: "turn.started" }).exited).toBeUndefined();
  });
  it("clears the prior exit when a Claude host starts streaming", () => {
    expect(reduceChat(crashed(), {
      type: "stream_event", event: { type: "message_start", message: { id: "new-answer" } },
    }).exited).toBeUndefined();
  });
  it("preserves actual Codex command exit evidence through start and completion", () => {
    let chat = reduceChat(emptyChat(), {
      type: "item.started", item: { id: "check", type: "command_execution", command: "pnpm test", status: "in_progress" },
    });
    chat = reduceChat(chat, {
      type: "item.completed", item: { id: "check", type: "command_execution", command: "pnpm test", status: "completed", exit_code: 1, aggregated_output: "tests failed" },
    });
    const tool = chat.messages.flatMap((m) => m.blocks).find((b) => b.kind === "tool");
    expect(tool?.kind === "tool" && tool.details).toEqual({ exit_code: 1 });
  });
});
