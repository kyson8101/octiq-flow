import { describe, expect, it } from "vitest";
import type { Message } from "./chat";
import { previewMessages, readChatPreview } from "./chatPreview";

const message = (id: string, text: string, extra: Partial<Message> = {}): Message => ({
  id, role: "user", streaming: false, blocks: [{ kind: "text", text }], ...extra,
});

describe("chat preview", () => {
  it("shows the latest three readable messages in order, excluding internal activity", () => {
    const messages = [
      message("old", "Older turn"), message("ask", "What changed?"),
      message("answer", "The sidebar.", { role: "assistant", speaker: { id: "a", name: "Nova", agent: "codex" } }),
      message("child", "Internal report", { parent: "tool-1" }),
      message("relay", "Injected prompt", { relay: "Continue" }),
      message("thinking", "", { blocks: [{ kind: "thinking", text: "Private reasoning" }] }),
      message("last", "Show me."),
    ];
    expect(previewMessages(messages)).toEqual([
      { id: "ask", speaker: "You", text: "What changed?" },
      { id: "answer", speaker: "Nova", text: "The sidebar." },
      { id: "last", speaker: "You", text: "Show me." },
    ]);
  });

  it("bounds long messages without losing the latest turn", () => {
    expect(previewMessages([message("long", "a".repeat(1000))])[0].text).toBe("a".repeat(420) + "…");
  });

  it("replays the recent server page and preserves imported chats with no server events", async () => {
    const fallback = [message("old", "Old local text")];
    const page = { context: [], before: 10, events: [{ seq: 10, event: {
      type: "user", uuid: "new", octiq_user_turn: true,
      message: { role: "user", content: [{ type: "text", text: "Latest server text" }] },
    } }] };
    const result = await readChatPreview(async () => page, fallback, () => false);
    expect(previewMessages(result)[0].text).toBe("Latest server text");
    expect(fallback[0].blocks).toEqual([{ kind: "text", text: "Old local text" }]);
    expect(await readChatPreview(async () => ({ context: [], events: [], before: null }), fallback, () => false)).toBe(fallback);
  });

  it("discards a response when the pointer has already left", async () => {
    expect(await readChatPreview(async () => ({ context: [], events: [], before: null }),
      [message("old", "Should not appear")], () => true)).toEqual([]);
  });
});
