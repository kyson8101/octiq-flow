import { describe, expect, it } from "vitest";
import type { Message } from "../lib/chat";
import { conversationMapTurns } from "./ConversationMap";

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
});
