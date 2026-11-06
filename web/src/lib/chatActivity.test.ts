import { expect, it } from "vitest";
import { emptyChat } from "./chat";
import { withStreamActivity, type ChatStreamActivity } from "./chatActivity";
import { restoredTurn, withWait } from "./turnClock";
const activity = (patch: Partial<ChatStreamActivity> = {}): ChatStreamActivity => ({ key: "chat:a", seq: 999, running: true, busy: true, turnId: "t", lastActivityAt: 1, work: false, ...patch });
it("keeps unknown host fields and never invents a transcript or advances a row clock", () => {
  const state = emptyChat();
  expect(withStreamActivity(state, activity({ busy: null, running: null, turnId: null }), 100)).toBe(state);
  const busy = withStreamActivity(state, activity(), 100);
  expect(busy.messages).toBe(state.messages); expect(busy.turnStartedAt).toBe(100);
  expect(withStreamActivity(busy, activity(), 200)).toBe(busy);
});
it("compact work reaches the restored-park machine only after its seen card clears", () => {
  const state = restoredTurn({ ...emptyChat(), busy: true, turnStartedAt: 1 }, 10);
  expect(withStreamActivity(state, activity({ work: true }), 20).turnWaits?.park).toBe("held");
  const seen = withWait(state, true, 20, "unread");
  expect(withStreamActivity(seen, activity({ work: true }), 25).turnWaits?.park).toBe("confirmed");
  const answered = withWait(seen, false, 30, "unread");
  expect(withStreamActivity(answered, activity(), 35).turnWaits?.park).toBe("answered");
  expect(withStreamActivity(answered, activity({ work: true }), 40).turnWaits?.park).toBeUndefined();
  expect(withStreamActivity(answered, activity({ work: true }), 40).turnWaits?.waited).toBe(30);
});

it("a different host turn starts a new clock without carrying the last turn's park", () => {
  const first = withStreamActivity(emptyChat(), activity(), 100);
  const parked = restoredTurn(first, 120);
  const next = withStreamActivity(parked, activity({ turnId: "next" }), 200);
  expect(next.turnStartedAt).toBe(200); expect(next.turnWaits).toBeUndefined();
});
