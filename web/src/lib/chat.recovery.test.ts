import { describe, expect, it } from "vitest";
import { addUserTurn, emptyChat, reduceChat } from "./chat";

describe("recovery exit evidence", () => {
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
  it("keeps the host exit when only a seat is addressed", () => {
    expect(addUserTurn(crashed(), "Review", [], 0, { id: "seat", name: "Reviewer" }).exited?.code).toBe(1);
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
