// The reviewer's probes (task_52315e24, findings 1-4, 6 and 7), as cases: a
// message is dated by which message it is, never by where it sits or whether a
// reducer copied it.
import { describe, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, reduceChat, type ChatState } from "./chat";
import { dayLabel, msUntilLocalMidnight, watchLocalDay } from "./messageTime";

const T = Date.UTC(2026, 10, 19, 13, 5);
const feed = (events: unknown[], state: ChatState = emptyChat()) =>
  events.reduce<ChatState>((s, e) => reduceChat(s, e), state);
const users = (s: ChatState) => s.messages.filter((m) => m.role === "user");
const replies = (s: ChatState) => s.messages.filter((m) => m.role === "assistant");

describe("finding 1: the host's envelope dates the person's bubble by turn id", () => {
  const envelope = { type: "user", uuid: "exact", octiq_user_turn: true, octiq_at: T, message: { content: "same turn" } };
  const echo = { type: "user", uuid: "echo", isReplay: true, octiq_user_turn_id: "exact", octiq_at: T + 600_000, message: { content: "same turn" } };

  it("replaces the browser's time even when the envelope changes nothing else", () => {
    let s = addUserTurn(emptyChat(), "same turn", [], T - 60_000, "exact");
    expect(users(s)[0]).toMatchObject({ at: T - 60_000, atLocal: true });
    s = reduceChat(s, envelope);
    expect(users(s)).toHaveLength(1);
    expect(users(s)[0].at).toBe(T);
    expect(users(s)[0].atLocal).toBeUndefined();
  });

  it("a later echo, even ten minutes on, moves nothing; live and reload agree", () => {
    const live = reduceChat(reduceChat(addUserTurn(emptyChat(), "same turn", [], T - 60_000, "exact"), envelope), echo);
    const reload = feed([envelope, echo]);
    expect(users(live)[0].at).toBe(T);
    expect(users(live).map((m) => m.at)).toEqual(users(reload).map((m) => m.at));
  });
});

describe("finding 2: a new tool result never re-dates a finished reply", () => {
  it("Pi: the first turn's reply keeps its time through the second turn's tool result", () => {
    let s = feed([
      { type: "turn_start", octiq_at: T - 1000 },
      { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Old finished answer" }] }, octiq_at: T },
      { type: "agent_settled", aborted: false, octiq_at: T + 1000 },
      { type: "user", uuid: "second", octiq_user_turn: true, octiq_at: T + 2000, message: { content: "second prompt" } },
      { type: "turn_start", octiq_user_turn_id: "second", octiq_at: T + 3000 },
      { type: "tool_execution_start", toolCallId: "tool", toolName: "read", args: {}, octiq_at: T + 4000 },
    ]);
    // Its full stop (agent_settled) was the last line of the first turn.
    expect(replies(s)[0].at).toBe(T + 1000);
    s = reduceChat(s, { type: "tool_execution_end", toolCallId: "tool", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, octiq_at: T + 10_000 });
    expect(replies(s)[0].at).toBe(T + 1000);
    // The reply the tool belongs to is the one that moves.
    expect(replies(s)[1].at).toBe(T + 10_000);
  });

  it("Codex: the clone-all tool result branch leaves an older reply alone", () => {
    const item = (id: string, state: string) => ({
      item: { id, type: "command_execution", command: "ls", status: state === "started" ? "in_progress" : "completed", aggregated_output: "", exit_code: 0 },
    });
    let s = feed([
      { type: "user", uuid: "a", octiq_user_turn: true, octiq_at: T - 1000, message: { content: "one" } },
      { type: "turn.started", octiq_user_turn_id: "a", octiq_at: T },
      { type: "item.completed", item: { type: "agent_message", id: "m", text: "first answer" }, octiq_at: T + 1000 },
      { type: "turn.completed", octiq_at: T + 2000 },
      { type: "user", uuid: "b", octiq_user_turn: true, octiq_at: T + 3000, message: { content: "two" } },
      { type: "turn.started", octiq_user_turn_id: "b", octiq_at: T + 4000 },
      { type: "item.started", ...item("i0", "started"), octiq_at: T + 5000 },
    ]);
    expect(replies(s)[0].at).toBe(T + 2000);
    s = reduceChat(s, { type: "item.completed", ...item("i0", "completed"), octiq_at: T + 20_000 });
    expect(replies(s)[0].at).toBe(T + 2000);
    expect(replies(s)[1].at).toBe(T + 20_000);
  });
});

describe("finding 3: Antigravity's native lines date their reply", () => {
  it("a step_update with no type gets the host time", () => {
    const s = feed([{ event: "step_update", step_update: { step_type: "agent_response", state: "RUNNING", text_delta: "Hello from agy" }, octiq_at: T }]);
    expect(replies(s)).toHaveLength(1);
    expect(replies(s)[0].at).toBe(T);
  });

  it("its result is the full stop and moves the reply forward; the user_input step dates nothing", () => {
    const s = feed([
      { event: "step_update", step_update: { step_type: "agent_response", state: "RUNNING", text_delta: "Hi" }, octiq_at: T },
      { event: "result", result: { status: "SUCCESS" }, octiq_at: T + 5000 },
    ]);
    expect(replies(s)[0].at).toBe(T + 5000);
    const after = reduceChat(s, { event: "step_update", step_update: { step_type: "user_input", state: "DONE" }, octiq_at: T + 9000 });
    expect(replies(after)[0].at).toBe(T + 5000);
  });
});

describe("finding 4: a Codex reply ahead of five queued prompts is dated", () => {
  it("dates the reply and every prompt", () => {
    const events: unknown[] = [
      { type: "user", uuid: "first", octiq_user_turn: true, octiq_at: T - 1000, message: { content: "first prompt" } },
      { type: "turn.started", octiq_user_turn_id: "first", octiq_at: T },
    ];
    for (let i = 0; i < 5; i++) events.push({ type: "user", uuid: `q${i}`, octiq_user_turn: true, octiq_at: T + i * 1000, message: { content: `queued ${i}` } });
    events.push({ type: "item.completed", item: { type: "agent_message", id: "a", text: "Reply with five queued prompts" }, octiq_at: T + 10_000 });
    events.push({ type: "turn.completed", octiq_at: T + 20_000 });
    const s = feed(events);
    // The reply sits before the waiting prompts; its time is the full stop's.
    expect(replies(s)).toHaveLength(1);
    expect(s.messages.indexOf(replies(s)[0])).toBeLessThan(s.messages.findIndex((m) => m.turnId === "q0"));
    expect(replies(s)[0].at).toBe(T + 20_000);
    expect(users(s).map((m) => m.at)).toEqual([T - 1000, T, T + 1000, T + 2000, T + 3000, T + 4000]);
  });
});

describe("finding 7: Yesterday is a calendar day, not 24 hours", () => {
  const where = { timeZone: "America/New_York" };
  it("the day after a spring-forward is not Yesterday two days on", () => {
    const now = Date.parse("2026-03-09T00:30:00-04:00");
    expect(dayLabel(Date.parse("2026-03-07T12:00:00-05:00"), now, where)).not.toBe("Yesterday");
    expect(dayLabel(Date.parse("2026-03-08T12:00:00-04:00"), now, where)).toBe("Yesterday");
  });
  it("and across the fall-back", () => {
    const now = Date.parse("2026-11-02T00:30:00-05:00");
    expect(dayLabel(Date.parse("2026-11-01T12:00:00-05:00"), now, where)).toBe("Yesterday");
    expect(dayLabel(Date.parse("2026-10-31T23:30:00-04:00"), now, where)).not.toBe("Yesterday");
  });
});

describe("finding 6: the day clock", () => {
  it("counts to the next local midnight from the calendar", () => {
    const at = new Date(2026, 10, 19, 23, 59, 0).getTime();
    expect(msUntilLocalMidnight(at)).toBe(60_000);
  });

  it("fires once per local midnight, with one timer and no tick, and stops when told", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 19, 23, 59, 0));
      const changed = vi.fn();
      const stop = watchLocalDay(changed);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(59_000);
      expect(changed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(24 * 3_600_000);
      expect(changed).toHaveBeenCalledTimes(2);
      stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
