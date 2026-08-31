import { describe, expect, it } from "vitest";
import type { Message } from "../lib/chat";
import { conversationMapPointWidth, conversationMapRank, conversationMapTurns } from "./ConversationMap";

const message = (id: string, role: Message["role"], text: string): Message => ({
  id,
  role,
  blocks: [{ kind: "text", text }],
  streaming: false,
});

describe("conversation map point breaks", () => {
  it("uses sent messages as anchors and previews their next reply", () => {
    const turns = [
      [message("u1", "user", "Can we change the provider mid-conversation?")],
      [message("a1", "assistant", "No. Each conversation keeps one provider authoritative.")],
      [message("u2", "user", "What about the command list?")],
      [message("a2", "assistant", "It stays with that provider too.")],
    ];

    expect(conversationMapTurns(turns)).toEqual([
      {
        id: "u1",
        prompt: "Can we change the provider mid-conversation?",
        reply: "No. Each conversation keeps one provider authoritative.",
      },
      {
        id: "u2",
        prompt: "What about the command list?",
        reply: "It stays with that provider too.",
      },
    ]);
  });

  it("keeps a sent message visible on the map while its answer is still absent", () => {
    expect(conversationMapTurns([[message("u1", "user", "Still working?")]])).toEqual([
      { id: "u1", prompt: "Still working?", reply: "" },
    ]);
  });

  it("lays out points in turn order", () => {
    expect(conversationMapRank(0, 3)).toBe(0);
    expect(conversationMapRank(1, 3)).toBeCloseTo(1 / 3);
    expect(conversationMapRank(2, 3)).toBeCloseTo(2 / 3);
  });

  it("uses a fixed dash width until a turn is pointed at", () => {
    expect(conversationMapPointWidth(null)).toBe(12);
    expect(conversationMapPointWidth(0)).toBe(32);
  });

  it("lifts the neighbours with the pointed-at turn, symmetrically and to a limit", () => {
    const hill = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map(conversationMapPointWidth);

    expect(hill).toEqual([12, 12, 17, 27, 32, 27, 17, 12, 12]);
    // A hill, not a step: every dash between the base and the peak is taller
    // than the one further from the pointer.
    expect(hill.slice(0, 5)).toEqual([...hill.slice(0, 5)].sort((a, b) => a - b));
  });
});
