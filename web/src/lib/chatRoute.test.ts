import { describe, expect, it } from "vitest";
import { chatRouteHash, readChatRoute } from "./chatRoute";

describe("single chat navigation", () => {
  it("keeps project-slug and UUID links readable", () => {
    expect(readChatRoute("#/p/octiq-flow/c/chat-1")).toEqual({ project: "octiq-flow", chat: "chat-1" });
    expect(readChatRoute("#/p/old-uuid")).toEqual({ project: "old-uuid" });
  });
  it("round-trips chat and project links with encoded characters", () => {
    for (const route of [{ chat: "a/&中文" }, { project: "project ?#", chat: "b/&中文" }, {}]) {
      expect(readChatRoute(chatRouteHash(route))).toEqual(route);
    }
  });
  it("opens the focused chat from retired split links", () => {
    expect(readChatRoute("#/split?left=a&right=b&focus=right")).toEqual({ chat: "b" });
    expect(readChatRoute("#/split?left=a&right=b")).toEqual({ chat: "a" });
    expect(readChatRoute("#/split?left=a&right=b&focus=garbage")).toEqual({ chat: "a" });
    expect(readChatRoute("#/split?left=a&right=a")).toEqual({ chat: "a" });
  });
  it("falls back when a retired split target is missing", () => {
    expect(readChatRoute("#/split?left=a&focus=right")).toEqual({ chat: "a" });
    expect(readChatRoute("#/split?right=b")).toEqual({ chat: "b" });
    expect(readChatRoute("#/split?")).toEqual({});
    expect(readChatRoute("#/p/%ZZ/c/x")).toEqual({});
  });
});
