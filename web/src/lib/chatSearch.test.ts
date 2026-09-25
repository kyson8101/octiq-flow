import { describe, expect, it } from "vitest";
import { chatSearchResults, isSearchable, type ChatSearchHit } from "./chatSearch";
import type { Conversation } from "./store";

const chat = (id: string): Conversation => ({
  id, projectId: "p1", title: `Task ${id}`, messages: [], createdAt: 1, updatedAt: 1,
});
const hit = (id: string): ChatSearchHit => ({ id, excerpt: `about ${id}`, speaker: "Claude", role: "assistant" });

describe("chatSearchResults", () => {
  it("keeps the backend's rank order", () => {
    const results = chatSearchResults([hit("b"), hit("a")], [chat("a"), chat("b")]);
    expect(results.map((result) => result.chat.id)).toEqual(["b", "a"]);
    expect(results[0].hit.excerpt).toBe("about b");
  });

  it("drops a hit for a chat this browser no longer lists", () => {
    // Deleted here a moment ago, still in the server's search cache.
    expect(chatSearchResults([hit("gone"), hit("a")], [chat("a")]).map((result) => result.chat.id)).toEqual(["a"]);
  });

  it("lists a chat once even if the backend names it twice", () => {
    expect(chatSearchResults([hit("a"), hit("a")], [chat("a")])).toHaveLength(1);
  });
});

describe("isSearchable", () => {
  it("needs two characters after trimming, counted as characters", () => {
    expect(isSearchable(" a ")).toBe(false);
    expect(isSearchable("ab")).toBe(true);
    // One emoji is two UTF-16 units but one character: the backend refuses it.
    expect(isSearchable("🙂")).toBe(false);
  });
});
