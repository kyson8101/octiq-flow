import { expect, it } from "vitest";
import type { Message } from "./chat";
import { lf } from "./sourceText";
import messageListSource from "../components/MessageList.tsx?raw";
import { initialTurn, lastRequest, needsEarlierPage, orientedFirst, runningTurns, TURN_BATCH } from "./messageWindow";

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

it("asks for one earlier server page only when what is loaded holds no request", () => {
  const tail = Array.from({ length: 30 }, (_, i) => agent(`a${i}`));
  const idle = { hasEarlier: true, loading: false, failed: false };
  // A tail longer than a window batch still holds nothing to orient by.
  expect(needsEarlierPage(tail, idle)).toBe(true);
  expect(needsEarlierPage([user("u1"), ...tail], idle)).toBe(false);
  expect(needsEarlierPage(tail, { ...idle, hasEarlier: false })).toBe(false);
  expect(needsEarlierPage(tail, { ...idle, loading: true })).toBe(false);
  expect(needsEarlierPage(tail, { ...idle, failed: true })).toBe(false);
  expect(needsEarlierPage([], idle)).toBe(false);
});

it("MessageList's reorientation reads the server page, not only the local window, once per conversation", () => {
  const source = lf(messageListSource);
  // The effect asks the pure rule, then loads in orient mode, and marks the
  // conversation only once a read can start.
  const effect = source.slice(source.indexOf("const reoriented = useRef"), source.indexOf("useLayoutEffect(() => {\n    const saved"));
  expect(effect).toMatch(/needsEarlierPage\(/);
  expect(effect.indexOf("scrollerRef.current")).toBeLessThan(effect.indexOf("reoriented.current = conversationId"));
  expect(effect).toMatch(/loadMore\(false, true\)/);
  // Orient mode skips the local widening branch and goes to onLoadEarlier.
  expect(source).toMatch(/if \(start > 0 && !orient\) \{\n\s+await ready\(\);/);
  expect(source).toMatch(/else await onLoadEarlier\?\.\(ready\)/);
});
