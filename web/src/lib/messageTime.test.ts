import { describe, expect, it } from "vitest";
import { addUserTurn, emptyChat, reduceChat, type ChatState } from "./chat";
import { replayChat } from "./replayChat";
import { clockLabel, dayKey, dayLabel, dividerBefore, fullLabel, readEventTime, turnTime } from "./messageTime";

const KL = { timeZone: "Asia/Kuala_Lumpur", locale: "en-GB" };
const US = { timeZone: "Asia/Kuala_Lumpur", locale: "en-US" };
// 2026-11-19 21:05 in Kuala Lumpur (UTC+8).
const T1 = Date.UTC(2026, 10, 19, 13, 5, 0);
// Ten minutes before KL midnight, and twenty minutes after it.
const BEFORE_MIDNIGHT = Date.UTC(2026, 10, 19, 15, 50, 0);
const AFTER_MIDNIGHT = Date.UTC(2026, 10, 19, 16, 20, 0);

const assistant = (text: string, extra: Record<string, unknown> = {}, id = "a1") =>
  ({ type: "assistant", message: { id, role: "assistant", content: [{ type: "text", text }] }, ...extra });

const feed = (events: unknown[], state: ChatState = emptyChat()) =>
  events.reduce<ChatState>((s, e) => reduceChat(s, e), state);

describe("which time a line carries", () => {
  it("reads the host's octiq_at, in epoch milliseconds", () => {
    expect(readEventTime({ octiq_at: T1 })).toEqual({ at: T1, host: true });
  });

  it("falls back to the provider's own timestamp: ISO text, milliseconds or seconds", () => {
    expect(readEventTime({ timestamp: "2026-11-19T13:05:00.000Z" })).toEqual({ at: T1, host: false });
    expect(readEventTime({ timestamp: T1 })).toEqual({ at: T1, host: false });
    expect(readEventTime({ timestamp: T1 / 1000 })).toEqual({ at: T1, host: false });
    expect(readEventTime({ message: { timestamp: T1 } })).toEqual({ at: T1, host: false });
  });

  it("prefers the host's time to the provider's", () => {
    expect(readEventTime({ octiq_at: T1, timestamp: T1 + 99_000 })).toEqual({ at: T1, host: true });
  });

  it("says nothing for a line with neither, or with nonsense", () => {
    expect(readEventTime({})).toBeUndefined();
    expect(readEventTime({ octiq_at: "soon", timestamp: "not a date" })).toBeUndefined();
    expect(readEventTime({ octiq_at: 12 })).toBeUndefined();
    expect(readEventTime({ octiq_at: Number.NaN })).toBeUndefined();
  });
});

describe("the time a reducer puts on a message", () => {
  it("a reply takes the time of its LAST line", () => {
    const s = feed([
      assistant("one", { octiq_at: T1 }),
      assistant("one two", { octiq_at: T1 + 5_000 }),
      { type: "result", subtype: "success", octiq_at: T1 + 9_000 },
    ]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].at).toBe(T1 + 9_000);
  });

  it("a tool's result (a user line) does not move the reply's time", () => {
    const call = { type: "assistant", octiq_at: T1, message: { id: "a1", role: "assistant", content: [
      { type: "tool_use", id: "tool1", name: "Bash", input: { command: "ls" } }] } };
    const result = { type: "user", octiq_at: T1 + 60_000, message: { content: [
      { type: "tool_result", tool_use_id: "tool1", content: "ok" }] } };
    const s = feed([call, result]);
    expect(s.messages.filter((m) => m.role === "assistant")[0].at).toBe(T1);
    expect(s.messages.filter((m) => m.role === "user")).toHaveLength(0);
  });

  it("uses the provider's timestamp when the line has no host time", () => {
    const s = feed([assistant("hi", { timestamp: "2026-11-19T13:05:00Z" })]);
    expect(s.messages[0].at).toBe(T1);
  });

  it("a provider timestamp never replaces the host's on the same reply", () => {
    const s = feed([assistant("hi", { octiq_at: T1 }), assistant("hi there", { timestamp: T1 + 600_000 })]);
    expect(s.messages[0].at).toBe(T1);
  });

  it("an old line with no time leaves the message without one", () => {
    const s = feed([assistant("hi"), { type: "result", subtype: "success" }]);
    expect(s.messages[0].at).toBeUndefined();
    expect("at" in s.messages[0]).toBe(false);
  });

  it("a person's message takes its own line's time and keeps it past the echo", () => {
    const envelope = { type: "user", uuid: "t", octiq_user_turn: true, octiq_at: T1, message: { content: "words" } };
    const pickup = { type: "user", uuid: "echo-t", isReplay: true, octiq_user_turn_id: "t", octiq_at: T1 + 120_000, message: { content: "words" } };
    const s = feed([envelope, pickup]);
    const user = s.messages.filter((m) => m.role === "user");
    expect(user).toHaveLength(1);
    expect(user[0].at).toBe(T1);
    expect(user[0].atLocal).toBeUndefined();
  });

  it("the browser's clock on a message just sent gives way to the host's line", () => {
    let s = addUserTurn(emptyChat(), "words", [], T1 - 2_000, "t");
    expect(s.messages[0].at).toBe(T1 - 2_000);
    expect(s.messages[0].atLocal).toBe(true);
    s = reduceChat(s, { type: "user", uuid: "echo-t", isReplay: true, octiq_user_turn_id: "t", octiq_at: T1, message: { content: "words" } });
    expect(s.messages[0].at).toBe(T1);
    expect(s.messages[0].atLocal).toBeUndefined();
  });

  it("a delivery receipt or a dismissal of the turn does not re-date it", () => {
    let s = feed([{ type: "user", uuid: "t", octiq_user_turn: true, octiq_at: T1, message: { content: "words" } }]);
    s = reduceChat(s, { type: "octiq_user_turn_delivery", uuid: "t", state: "dispatched", octiq_at: T1 + 30_000 });
    s = reduceChat(s, { type: "turn.started", octiq_user_turn_id: "t", octiq_at: T1 + 60_000 });
    expect(s.messages.find((m) => m.role === "user")?.at).toBe(T1);
  });

  it("live and a reload of the same lines agree", async () => {
    const lines = [
      { type: "user", uuid: "t", octiq_user_turn: true, octiq_at: T1, message: { content: "words" } },
      assistant("answer", { octiq_at: T1 + 4_000 }),
      { type: "result", subtype: "success", octiq_at: T1 + 7_000 },
      { type: "user", uuid: "u2", octiq_user_turn: true, octiq_at: AFTER_MIDNIGHT, message: { content: "again" } },
      assistant("more", { octiq_at: AFTER_MIDNIGHT + 3_000 }, "a2"),
    ];
    const live = feed(lines);
    const replay = await replayChat(emptyChat(), lines.map((event, i) => ({ seq: i + 1, event })), 0, () => false);
    expect(replay.messages.map((m) => [m.role, m.at])).toEqual(live.messages.map((m) => [m.role, m.at]));
    expect(live.messages.map((m) => m.at)).toEqual([T1, T1 + 7_000, AFTER_MIDNIGHT, AFTER_MIDNIGHT + 3_000]);
  });

  it("turnTime is the newest time a reply's messages have", () => {
    expect(turnTime([{ at: 1 } as never, { at: 5 } as never, {} as never], "assistant")).toBe(5);
    expect(turnTime([{ at: 7 } as never], "user")).toBe(7);
    expect(turnTime([{} as never], "assistant")).toBeUndefined();
  });
});

describe("the words", () => {
  it("writes a short clock the way the locale does", () => {
    expect(clockLabel(T1, KL)).toMatch(/21:05/);
    expect(clockLabel(T1, US)).toMatch(/9:05\s?pm/i);
  });

  it("writes the whole date and time", () => {
    expect(fullLabel(T1, KL)).toMatch(/Thursday/);
    expect(fullLabel(T1, KL)).toMatch(/19 November 2026/);
    expect(fullLabel(T1, KL)).toMatch(/21:05/);
  });

  it("says Today, Yesterday, then a date", () => {
    const now = Date.UTC(2026, 10, 20, 2, 0, 0); // 10:00 on the 20th in KL
    expect(dayLabel(now - 3_600_000, now, KL)).toBe("Today");
    expect(dayLabel(T1, now, KL)).toBe("Yesterday");
    expect(dayLabel(Date.UTC(2026, 10, 10, 4, 0, 0), now, KL)).toMatch(/10/);
    expect(dayLabel(Date.UTC(2025, 10, 10, 4, 0, 0), now, KL)).toMatch(/2025/);
  });
});

describe("the day divider", () => {
  it("splits at local midnight, not at UTC midnight", () => {
    // 15:50Z and 16:20Z are the same UTC day and two different days in KL.
    expect(dayKey(BEFORE_MIDNIGHT, KL)).not.toBe(dayKey(AFTER_MIDNIGHT, KL));
    expect([...dividerBefore([BEFORE_MIDNIGHT, AFTER_MIDNIGHT], KL)]).toEqual([1]);
    // And the same two stay together in a zone where both are one day (UTC).
    expect([...dividerBefore([BEFORE_MIDNIGHT, AFTER_MIDNIGHT], { timeZone: "UTC" })]).toEqual([]);
  });

  it("is never before the first dated turn, and skips turns with no time", () => {
    expect([...dividerBefore([undefined, T1, undefined, T1 + 60_000])]).toEqual([]);
    expect([...dividerBefore([undefined, BEFORE_MIDNIGHT, undefined, AFTER_MIDNIGHT], KL)]).toEqual([3]);
  });
});
