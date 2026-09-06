import { describe, expect, it } from "vitest";
import { emptyChat } from "./chat";
import { observeInterruptions, ROOM_HANDOVER_MS, type InterruptionInput } from "./interruptions";

const input = (over: Partial<InterruptionInput> = {}): InterruptionInput => ({
  chats: { host: { ...emptyChat(), busy: true } }, running: new Set(),
  activeRounds: new Set(), rooms: new Set(), known: true, ...over,
});

describe("interruption observation", () => {
  it("confirms ordinary missing work immediately", () => {
    expect(observeInterruptions(new Map(), input(), 100).interrupted.has("host")).toBe(true);
  });
  it("shares room handover grace across repeated renders", () => {
    const room = input({ rooms: new Set(["host"]) });
    const first = observeInterruptions(new Map(), room, 100);
    expect(first.interrupted.size).toBe(0);
    const next = observeInterruptions(first.missing, room, 1000);
    expect(next.nextCheck).toBe(100 + ROOM_HANDOVER_MS);
    expect(observeInterruptions(next.missing, room, 100 + ROOM_HANDOVER_MS).interrupted.has("host")).toBe(true);
  });
  it("clears absence on disconnect, active round, live seat, stop and turn completion", () => {
    const previous = new Map([["host", 100]]);
    for (const over of [
      { known: false }, { activeRounds: new Set(["host"]) }, { running: new Set(["host-seat-a"]) },
      { chats: { host: { ...emptyChat(), busy: true, stopping: true } } },
      { chats: { host: emptyChat() } },
    ]) expect(observeInterruptions(previous, input(over), 40_000).missing.size).toBe(0);
  });
});
