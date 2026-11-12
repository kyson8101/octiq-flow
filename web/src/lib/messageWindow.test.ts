import { expect, it } from "vitest";
import type { Message } from "./chat";
import { initialTurn, lastRequest, orientedFirst, runningTurns, TURN_BATCH } from "./messageWindow";

const text = (t: string) => ({ kind: "text", text: t }) as Message["blocks"][number];
const user = (id: string, extra: Partial<Message> = {}): Message[] =>
  [{ id, role: "user", blocks: [text(`say ${id}`)], streaming: false, ...extra } as Message];
const agent = (id: string, extra: Partial<Message> = {}): Message[] =>
  [{ id, role: "assistant", blocks: [text(`did ${id}`)], streaming: false, ...extra } as Message];
const queued = (id: string) => user(id, { delivery: "queued" });

it("finds the person's last real request, not a queued prompt or a host turn", () => {
  const turns = [user("u1"), agent("a1"), user("h", { turnId: "octiq-job-1" }), agent("a2"), queued("q")];
  expect(lastRequest(turns)).toBe(0);
  expect(lastRequest([agent("a")])).toBe(-1);
});

it("backs a window cut to the last turns up to the last request, and never later", () => {
  const turns = [user("u1"), agent("a1"), agent("a2"), agent("a3"), agent("a4"), agent("a5")];
  expect(orientedFirst(turns, "a4")).toBe("u1");
  expect(orientedFirst(turns, "u1")).toBe("u1");
  expect(orientedFirst(turns, null)).toBeNull();
  expect(orientedFirst([agent("a1"), agent("a2")], "a2")).toBe("a2");
});

it("leaves a window alone when the last request is too far back", () => {
  const turns = [user("u1"), ...Array.from({ length: 60 }, (_, i) => agent(`a${i}`))];
  expect(orientedFirst(turns, "a50")).toBe("a50");
});

it("keeps the first paint on the end for a chat with few turns", () => {
  const turns = Array.from({ length: TURN_BATCH + 3 }, (_, i) => (i % 2 ? agent(`a${i}`) : user(`u${i}`)));
  expect(initialTurn(turns)).not.toBeNull();
});

it("counts every assistant turn of the running turn, across a queued prompt", () => {
  const turns = [user("u1"), agent("a1"), queued("q"), agent("a2")];
  expect([...runningTurns(turns, true)]).toEqual(["a2", "a1"]);
  expect(runningTurns(turns, false).size).toBe(0);
});

it("stops at a turn that ended or a prompt the agent took up", () => {
  const ended = [user("u1"), agent("a1", { turnEnd: { status: "completed" } }), agent("a2")];
  expect([...runningTurns(ended, true)]).toEqual(["a2"]);
  const taken = [user("u1"), agent("a1"), user("u2", { takenUp: true }), agent("a2")];
  expect([...runningTurns(taken, true)]).toEqual(["a2"]);
});
