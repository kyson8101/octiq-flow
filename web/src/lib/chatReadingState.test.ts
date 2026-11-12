import { expect, it } from "vitest";
import { ChatReadingState, ChatReadingStates, READING_STATE_VALUES } from "./chatReadingState";

it("retains window and presentation choices by chat, including closed defaults", () => {
  const cache = new ChatReadingStates();
  const a = cache.open("a"); a.first = "older-message";
  a.set("tool:1", true); a.set("diff:2", false); a.set("tab:3", "history"); a.set("empty", null);
  cache.open("b").set("tool:1", false);
  expect(cache.open("a")).toBe(a);
  expect(a.first).toBe("older-message");
  expect(a.get("tool:1")).toBe(true); expect(a.get("diff:2")).toBe(false);
  expect(a.get("tab:3")).toBe("history"); expect(a.get("empty")).toBeNull();
  expect(cache.open("b").get("tool:1")).toBe(false);
});

it("keeps the state of every chat it is asked about; a count never drops a held window", () => {
  const cache = new ChatReadingStates();
  const first = cache.open("first"); first.set("open", true); first.first = "m1";
  for (let i = 0; i < 200; i++) cache.open(`c${i}`).set("open", true);
  expect(cache.open("first")).toBe(first);
  expect(first.get("open")).toBe(true); expect(first.first).toBe("m1");
  // Only the owner of the window releases it.
  cache.forget("first"); first.set("late-unmount", true);
  expect(first.get("late-unmount")).toBeUndefined();
  expect(cache.open("first")).not.toBe(first);
});

it("bounds choices within a chat by count and bytes without retaining transcript-sized values", () => {
  const state = new ChatReadingState();
  for (let i = 0; i <= READING_STATE_VALUES; i++) state.set(String(i), true);
  expect(state.get("0")).toBeUndefined(); expect(state.get(String(READING_STATE_VALUES))).toBe(true);
  const bytes = new ChatReadingState();
  for (let i = 0; i < 4000; i++) bytes.set(`${i}:` + "k".repeat(900), "x".repeat(900));
  expect(bytes.get("0:" + "k".repeat(900))).toBeUndefined();
  expect(bytes.get("3999:" + "k".repeat(900))).toBe("x".repeat(900));
  bytes.set("transcript", "x".repeat(10 * 1024 * 1024));
  expect(bytes.get("transcript")).toBeUndefined();
});

it("reset/eviction invalidates an old mounted scope so it cannot resurrect choices", () => {
  const cache = new ChatReadingStates(), old = cache.open("a");
  old.first = "old"; old.set("fold", true);
  cache.forget("a"); old.set("fold", true);
  const fresh = cache.open("a");
  expect(fresh).not.toBe(old); expect(fresh.first).toBeUndefined(); expect(fresh.get("fold")).toBeUndefined();
});
