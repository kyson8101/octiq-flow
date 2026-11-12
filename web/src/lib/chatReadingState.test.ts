import { expect, it } from "vitest";
import { ChatReadingState, ChatReadingStates, READING_STATE_CHATS, READING_STATE_VALUES } from "./chatReadingState";

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

it("bounds recent chats, promotes a return, and discards the oldest state", () => {
  const cache = new ChatReadingStates();
  const oldest = cache.open("oldest"), recent = cache.open("recent");
  oldest.set("open", true); recent.first = null;
  for (let i = 0; i < 6; i++) cache.open(String(i));
  expect(cache.open("recent")).toBe(recent);
  cache.open("overflow");
  expect(cache.open("recent")).toBe(recent);
  expect(cache.open("oldest")).not.toBe(oldest);
  oldest.set("late-unmount", true);
  expect(oldest.get("late-unmount")).toBeUndefined();
});

it("bounds choices within a chat by count and bytes without retaining transcript-sized values", () => {
  const state = new ChatReadingState();
  for (let i = 0; i <= READING_STATE_VALUES; i++) state.set(String(i), true);
  expect(state.get("0")).toBeUndefined(); expect(state.get(String(READING_STATE_VALUES))).toBe(true);
  const bytes = new ChatReadingState();
  for (let i = 0; i < 200; i++) bytes.set(`${i}:` + "k".repeat(900), "x".repeat(900));
  expect(bytes.get("0:" + "k".repeat(900))).toBeUndefined();
  expect(bytes.get("199:" + "k".repeat(900))).toBe("x".repeat(900));
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
