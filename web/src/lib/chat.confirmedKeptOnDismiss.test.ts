import { describe, expect, it } from "vitest";
import { addUserTurn, emptyChat, reduceChat } from "./chat";
import { replayChat } from "./replayChat";

// A late or wrong octiq_user_turn_dismissed / _cancelled line must not take
// back a message the agent already confirmed (echo or pickup). Ported from the
// round-3 review's guard-race-ui.log; live and replay follow one rule.
const turn = "t";
const envelope = { type: "user", uuid: turn, octiq_user_turn: true, message: { content: "words" } };
const pickup = { type: "user", uuid: "echo-t", isReplay: true, octiq_user_turn_id: turn, message: { content: "words" } };
const dismissed = { type: "octiq_user_turn_dismissed", uuid: turn };
const cancelled = { type: "octiq_user_turn_cancelled", uuid: turn };

describe("a confirmed message survives a late dismiss or cancel", () => {
  it("live: echo, then dismissed — the message stays", () => {
    let s = addUserTurn(emptyChat(), "words", [], 1, turn);
    s = reduceChat(s, pickup);
    expect(s.messages.find((m) => m.turnId === turn)?.echo).toBe("echo-t");
    s = reduceChat(s, dismissed);
    expect(s.messages.some((m) => m.turnId === turn)).toBe(true);
    expect(s.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("live: echo, then cancelled — the message stays", () => {
    let s = addUserTurn(emptyChat(), "words", [], 1, turn);
    s = reduceChat(s, pickup);
    s = reduceChat(s, cancelled);
    expect(s.messages.some((m) => m.turnId === turn)).toBe(true);
  });

  it("live: a taken-up message (Codex turn.started) stays", () => {
    let s = addUserTurn(emptyChat(), "words", [], 1, turn);
    s = reduceChat(s, { type: "turn.started", octiq_user_turn_id: turn });
    expect(s.messages.find((m) => m.turnId === turn)?.takenUp).toBe(true);
    s = reduceChat(s, dismissed);
    expect(s.messages.some((m) => m.turnId === turn)).toBe(true);
  });

  it("replay: pickup line, then dismissed line — the message stays", async () => {
    const frames = [envelope, pickup, dismissed].map((event, i) => ({ seq: i + 1, event }));
    const s = await replayChat(emptyChat(), frames, 0, () => false);
    expect(s.messages.some((m) => m.turnId === turn || m.echo === "echo-t")).toBe(true);
  });

  it("replay: pickup line, then cancelled line — the message stays", async () => {
    const frames = [envelope, pickup, cancelled].map((event, i) => ({ seq: i + 1, event }));
    const s = await replayChat(emptyChat(), frames, 0, () => false);
    expect(s.messages.some((m) => m.turnId === turn || m.echo === "echo-t")).toBe(true);
  });

  it("no echo, then dismissed — the message is removed", () => {
    let s = addUserTurn(emptyChat(), "words", [], 1, turn);
    s = reduceChat(s, dismissed);
    expect(s.messages).toHaveLength(0);
  });

  it("replay: no pickup, then dismissed — the message is removed", async () => {
    const frames = [envelope, dismissed].map((event, i) => ({ seq: i + 1, event }));
    const s = await replayChat(emptyChat(), frames, 0, () => false);
    expect(s.messages.some((m) => m.turnId === turn)).toBe(false);
  });

  it("a queued message cancelled with its ✕ is removed", () => {
    let s = addUserTurn(emptyChat(), "words", [], 1, turn);
    s = reduceChat(s, { type: "octiq_user_turn_delivery", uuid: turn, state: "queued" });
    s = reduceChat(s, cancelled);
    expect(s.messages).toHaveLength(0);
  });
});
