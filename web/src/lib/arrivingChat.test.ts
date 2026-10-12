import { describe, expect, it } from "vitest";
import { ARRIVAL_GRACE_MS, composesNewChat, stillArriving } from "./arrivingChat";
import app from "../App.tsx?raw";

const waiting = { conversationId: null, unavailable: null, gaveUp: false };

describe("the chat a link asked for, before it is on screen", () => {
  it("is waited for until a chat opens, it is called unavailable, or the list has answered and time has passed", () => {
    expect(stillArriving("lead", waiting)).toBe("lead");
    expect(stillArriving("lead", { ...waiting, conversationId: "lead" })).toBeNull();
    // Any chat on screen ends the wait: the person went somewhere else.
    expect(stillArriving("lead", { ...waiting, conversationId: "other" })).toBeNull();
    expect(stillArriving("lead", { ...waiting, unavailable: "lead" })).toBeNull();
    expect(stillArriving("lead", { ...waiting, gaveUp: true })).toBeNull();
    // Nothing was asked for: nothing is waited for, then or later.
    expect(stillArriving(null, waiting)).toBeNull();
    expect(ARRIVAL_GRACE_MS).toBe(3_000);
  });

  it("keeps the new conversation's composer off the page while it waits", () => {
    // F5: the project-and-branch row was drawn for a moment and removed.
    expect(composesNewChat(null, "lead")).toBe(false);
    expect(composesNewChat(null, null)).toBe(true);
    expect(composesNewChat("lead", null)).toBe(false);
    expect(composesNewChat("lead", "lead")).toBe(false);
  });

  it("is what the app's composer asks", () => {
    expect(app).toContain("showWorkLocation={composesNewChat(conversationId, arrivingChat) && !executionPlan?.crossProject}");
    expect(app).toContain("useState<string | null>(() => opened.current.chat ?? null)");
  });
});
