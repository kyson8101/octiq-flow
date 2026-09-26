import { describe, expect, it, vi } from "vitest";
import { chatRouteHash, readChatRoute, replaceChatRoute } from "./chatRoute";

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
  it("carries a task chat open beside the main chat", () => {
    expect(readChatRoute("#/p/general/c/lead/beside/orch-1")).toEqual({ project: "general", chat: "lead", beside: "orch-1" });
    expect(readChatRoute("#/c/lead/beside/orch-1")).toEqual({ chat: "lead", beside: "orch-1" });
    for (const route of [{ project: "general", chat: "lead", beside: "orch/1 ?" }, { chat: "a", beside: "b" }]) {
      expect(readChatRoute(chatRouteHash(route))).toEqual(route);
    }
    // Nothing to be beside without a chat.
    expect(chatRouteHash({ project: "general", beside: "orch-1" })).toBe("#/p/general");
    expect(readChatRoute("#/p/general/beside/orch-1")).toEqual({});
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
  it("replaces the current URL instead of stacking chat selections in browser history", () => {
    const replaceState = vi.fn();
    const changed = replaceChatRoute(
      { hash: "#/p/octiq-flow/c/chat-1", pathname: "/", search: "?token=kept" },
      { replaceState },
      { project: "octiq-flow", chat: "chat-2" },
    );
    expect(changed).toBe(true);
    expect(replaceState).toHaveBeenCalledExactlyOnceWith(null, "", "/?token=kept#/p/octiq-flow/c/chat-2");
  });
  it("does not touch history when the route is already current", () => {
    const replaceState = vi.fn();
    expect(replaceChatRoute(
      { hash: "#/c/chat-1", pathname: "/", search: "" },
      { replaceState },
      { chat: "chat-1" },
    )).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });
});
