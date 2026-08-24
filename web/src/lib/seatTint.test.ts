import { describe, expect, it } from "vitest";

import type { Message, Speaker } from "./chat";
import { SEAT_TINTS, seatKey, seatTints } from "./seatTint";

const seat = (name: string, id = name.toLowerCase()): Speaker => ({ id, name, agent: "claude" });

let n = 0;
const said = (speaker?: Speaker): Message => ({
  id: `m${n++}`,
  role: "assistant",
  blocks: [{ kind: "text", text: "..." }],
  streaming: false,
  ...(speaker ? { speaker } : {}),
});

const tintOf = (messages: Message[], name: string) =>
  seatTints(messages).get(seatKey(seat(name)));

describe("the colour each seat speaks in", () => {
  it("gives every seat in a room a colour of its own", () => {
    const names = ["Dee", "Ana", "Codex", "Rina", "Second opinion"];
    const tints = seatTints(names.map((name) => said(seat(name))));

    // The whole point. A hash would collide on a set this size four times out
    // of five — five seats into eight slots is the birthday problem — so the
    // colours are handed out in order instead, and distinctness is a promise.
    expect(new Set(tints.values()).size).toBe(names.length);
  });

  it("gives the host no colour at all — it is not a seat", () => {
    expect(seatTints([said(), said(seat("Dee"))]).size).toBe(1);
  });

  it("keeps a seat's colour the same however often it speaks", () => {
    const messages = [said(seat("Dee")), said(seat("Ana")), said(seat("Dee"))];

    expect(tintOf(messages, "Dee")).toBe(0);
    expect(tintOf(messages, "Ana")).toBe(1);
  });

  it("does not shift a seat's colour when someone new joins later", () => {
    const before = [said(seat("Dee")), said(seat("Ana"))];
    const after = [...before, said(seat("Rina"))];

    // Order of FIRST appearance, so the answers already on screen never change
    // colour under the reader when a seat is added mid-conversation.
    expect(tintOf(after, "Dee")).toBe(tintOf(before, "Dee"));
    expect(tintOf(after, "Ana")).toBe(tintOf(before, "Ana"));
  });

  it("survives a seat being dropped and added again, which changes its id", () => {
    const messages = [said({ id: "s1", name: "Dee", agent: "claude" })];
    const again = seatTints([...messages, { ...said(), speaker: { id: "s9", name: "Dee", agent: "claude" } }]);

    expect(again.size).toBe(1);
  });

  it("wraps rather than running out, in a room bigger than the palette", () => {
    const many = Array.from({ length: SEAT_TINTS + 3 }, (_, i) => said(seat(`Seat ${i}`)));
    const tints = seatTints(many);

    for (const tint of tints.values()) {
      expect(tint).toBeGreaterThanOrEqual(0);
      expect(tint).toBeLessThan(SEAT_TINTS);
    }
    expect(tints.size).toBe(SEAT_TINTS + 3);
  });
});
