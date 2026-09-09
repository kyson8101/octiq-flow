import { describe, expect, it } from "vitest";
import { beside, chatLayoutHash, chatRouteHash, paneMessage, readChatLayout, readChatRoute, sameRoute } from "./chatLayout";

describe("chat layout navigation", () => {
  it("keeps old project-slug and UUID links readable", () => {
    expect(readChatRoute("#/p/octiq-flow/c/chat-1")).toEqual({ project: "octiq-flow", chat: "chat-1" });
    expect(readChatRoute("#/p/old-uuid")).toEqual({ project: "old-uuid" });
  });
  it("round-trips cross-project chat IDs and the focused pane without project duplication", () => {
    const layout = { left: { project: "one", chat: "a/&中文" }, right: { project: "two", chat: "b ?#" }, focus: "right" as const };
    expect(readChatLayout(chatLayoutHash(layout))).toEqual({ left: { chat: "a/&中文" }, right: { chat: "b ?#" }, focus: "right" });
    expect(chatLayoutHash(layout)).not.toContain("project");
  });
  it("restores the exact split after a solo visit", () => {
    const split = beside({ left: { chat: "a" }, focus: "left" }, "left", "b");
    const history = [chatLayoutHash(split), chatLayoutHash({ left: { chat: "c" }, focus: "left" })];
    expect(readChatLayout(history[0])).toEqual(split);
  });
  it("opens into the opposite pane and leaves the source untouched", () => {
    const start = { left: { chat: "a" }, right: { chat: "b" }, focus: "left" as const };
    expect(beside(start, "right", "c")).toEqual({ left: { chat: "c" }, right: { chat: "b" }, focus: "left" });
    expect(beside(start, "left", "c")).toEqual({ left: { chat: "a" }, right: { chat: "c" }, focus: "right" });
  });
  it("focuses an existing pane rather than duplicating a chat", () => {
    expect(beside({ left: { chat: "a" }, right: { chat: "b" }, focus: "left" }, "left", "b").focus).toBe("right");
    expect(readChatLayout("#/split?left=a&right=a").right).toBeUndefined();
  });
  it("handles malformed links and missing split targets", () => {
    expect(readChatRoute("#/p/%ZZ/c/x")).toEqual({});
    expect(readChatLayout("#/split?left=a")).toEqual({ left: { chat: "a" }, focus: "left" });
    expect(readChatLayout("#/split?left=a&right=b&focus=garbage").focus).toBe("left");
    expect(chatRouteHash({})).toBe("");
  });
  it("resolves a chat route independent of whether the project has loaded", () => {
    expect(sameRoute({ chat: "a" }, { project: "project-a", chat: "a" })).toBe(true);
    expect(sameRoute({ project: "a" }, { project: "b" })).toBe(false);
  });
  it("rejects malformed frame messages", () => {
    expect(paneMessage({ type: "octiq-pane", action: "route", route: { chat: 42 }, title: "Chat" })).toBe(false);
    expect(paneMessage({ type: "octiq-pane", action: "beside", chat: "" })).toBe(false);
    expect(paneMessage({ type: "other", action: "focus" })).toBe(false);
    expect(paneMessage(null)).toBe(false);
    expect(paneMessage({ type: "octiq-pane", action: "route", route: { chat: "a" }, title: "A" })).toBe(true);
  });
});
