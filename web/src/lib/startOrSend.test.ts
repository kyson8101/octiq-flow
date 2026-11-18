import { describe, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat } from "./chat";
import { reconcileUnsentMessages } from "./recovery";
import { unconfirmedSend } from "./messageQueue";
import { lf } from "./sourceText";
import appSource from "../App.tsx?raw";
import { START_BACKOFF_MS, START_ROUNDS, STARTED_ELSEWHERE, startOrSend } from "./startOrSend";

const ALREADY = new Error("chat 'x' is already running");
const NO_CHAT = new Error("no such chat 'x'");

// A host that flip-flops `flips` times (start: already running, send: no such
// chat) and then lets the start through.
function host(flips: number) {
  let starts = 0;
  const start = vi.fn(async () => { if (++starts <= flips) throw ALREADY; });
  const send = vi.fn(async () => { throw NO_CHAT; });
  return { start, send };
}

describe("startOrSend", () => {
  it("starts straight away when nothing is in the way", async () => {
    const { start, send } = host(0);
    expect(await startOrSend({ start, send, wait: async () => {} })).toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends to the running chat on a plain collision", async () => {
    const start = vi.fn(async () => { throw ALREADY; });
    const send = vi.fn(async () => {});
    expect(await startOrSend({ start, send, wait: async () => {} })).toEqual({ ok: true });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("starts again after one flip-flop, with the same arguments, and succeeds", async () => {
    const { start, send } = host(1);
    const wait = vi.fn(async () => {});
    expect(await startOrSend({ start, send, wait })).toEqual({ ok: true });
    expect(start).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(START_BACKOFF_MS[0]);
  });

  it("gives up after the bounded rounds, as a definite refusal", async () => {
    const { start, send } = host(Infinity);
    const wait = vi.fn(async () => {});
    const out = await startOrSend({ start, send, wait });
    expect(out).toMatchObject({ ok: false, refused: true });
    expect(String((out as { error: Error }).error.message)).toBe(STARTED_ELSEWHERE);
    expect(start).toHaveBeenCalledTimes(START_ROUNDS);
    expect(send).toHaveBeenCalledTimes(START_ROUNDS);
    expect(wait).toHaveBeenCalledTimes(START_ROUNDS - 1);
  });

  it("leaves other errors alone, unknown and not retried", async () => {
    const down = new Error("connection closed");
    const a = await startOrSend({ start: async () => { throw down; }, send: async () => {}, wait: async () => {} });
    expect(a).toEqual({ ok: false, error: down, refused: false });
    const removed = new Error("The chat's folder /x was removed and could not be restored: gone.");
    const start = vi.fn(async () => { throw ALREADY; });
    const b = await startOrSend({ start, send: async () => { throw removed; }, wait: async () => {} });
    expect(b).toEqual({ ok: false, error: removed, refused: false });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("never sends a model switch into a running process", async () => {
    const send = vi.fn(async () => {});
    const out = await startOrSend({ start: async () => { throw ALREADY; }, wait: async () => {} });
    expect(out).toMatchObject({ ok: false, refused: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("stops when the lead send is no longer current", async () => {
    const { start, send } = host(Infinity);
    let current = true;
    const wait = async () => { current = false; };
    const out = await startOrSend({ start, send, wait, current: () => current });
    expect(out).toMatchObject({ ok: false, refused: false });
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe("what the page shows", () => {
  const sent = () => ({ ...addUserTurn(emptyChat(), "hello", [], 1, "turn"), busy: true });

  it("flip-flop once then success leaves one bubble and no error", async () => {
    const { start, send } = host(1);
    let state = sent();
    const out = await startOrSend({ start, send, wait: async () => {} });
    if (!out.ok) state = unconfirmedSend(state, "turn", out.error, false, out.refused);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ delivery: "sending" });
    expect(state.messages[0]?.queueError).toBeUndefined();
  });

  it("flip-flop forever is Not sent, restorable, and stays so on a queue read", async () => {
    const { start, send } = host(Infinity);
    const out = await startOrSend({ start, send, wait: async () => {} });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const state = unconfirmedSend(sent(), "turn", out.error, false, out.refused);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      delivery: "failed", queueLost: true, hostFailed: true, queueError: STARTED_ELSEWHERE,
    });
    for (const live of [true, false]) {
      const read = reconcileUnsentMessages(state, { live, queuedTurnIds: [] });
      expect(read.messages[0]).toMatchObject({ delivery: "failed", queueLost: true });
    }
  });

  it("an unknown error is still unconfirmed", () => {
    const state = unconfirmedSend(sent(), "turn", new Error("connection closed"), false, false);
    expect(state.messages[0]).toMatchObject({ delivery: "unknown", queueError: "connection closed" });
    expect(state.messages[0]?.queueLost).toBeUndefined();
  });
});

describe("App hand-off", () => {
  const app = lf(appSource);
  it("sends through startOrSend and passes the refusal on", () => {
    expect(app).toContain("await startOrSend({");
    expect(app).toContain("fail(outcome.error, outcome.refused);");
    expect(app).toContain("unconfirmedSend(s, turnId, err, runningRef.current.has(id), refused)");
  });
});
