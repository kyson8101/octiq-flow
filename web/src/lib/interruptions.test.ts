import { describe, expect, it } from "vitest";
import { emptyChat } from "./chat";
import { observeInterruptions, type InterruptionInput } from "./interruptions";

const input = (over: Partial<InterruptionInput> = {}): InterruptionInput => ({
  chats: { host: { ...emptyChat(), busy: true } }, running: new Set(),
  known: true, ...over,
});

describe("interruption observation", () => {
  it("confirms ordinary missing work immediately", () => {
    expect(observeInterruptions(new Map(), input(), 100).interrupted.has("host")).toBe(true);
  });
  it("clears absence on disconnect, a live process, stop and turn completion", () => {
    const previous = new Map([["host", 100]]);
    for (const over of [
      { known: false }, { running: new Set(["host"]) },
      { chats: { host: { ...emptyChat(), busy: true, stopping: true } } },
      { chats: { host: emptyChat() } },
    ]) expect(observeInterruptions(previous, input(over), 40_000).missing.size).toBe(0);
  });
});
