import { describe, expect, it } from "vitest";
import { mediaTime, orderedComments, playbackMs, reviewQuote } from "./mediaComments";
describe("media review anchors", () => {
  it("keeps milliseconds and carries into minutes and hours", () => {
    expect(mediaTime(0)).toBe("00:00.000");
    expect(mediaTime(12345)).toBe("00:12.345");
    expect(mediaTime(59999.9)).toBe("01:00.000");
    expect(mediaTime(3600123)).toBe("1:00:00.123");
    expect(mediaTime(NaN)).toBe("00:00.000");
  });
  it("captures the actual player time within its duration", () => {
    const player = { currentTime: 1.2345, duration: 5 };
    const captured = playbackMs(player);
    player.currentTime = 4;
    expect(captured).toBe(1235);
    expect(playbackMs({ currentTime: 12, duration: 5 })).toBe(5000);
    expect(playbackMs(null)).toBe(0);
  });
  it("sorts video notes by time without mutating the saved order and carries context to chat", () => {
    const comments = [{ id: "a", text: "later", timeMs: 2000, createdAt: 1 }, { id: "b", text: "cut", timeMs: 1234, createdAt: 2 }];
    expect(orderedComments(comments).map(c => c.id)).toEqual(["b", "a"]);
    expect(comments[0].id).toBe("a");
    expect(reviewQuote({ target: { path: "/clip.mp4", revision: "v1", kind: "video" }, comments }, comments[1])).toContain("00:01.234");
    expect(reviewQuote({ target: { path: "/still.png", revision: "v2", kind: "image" }, comments: [] }, { id: "x", text: "light", createdAt: 1 })).toContain("Image review\nSource revision: v2\nlight");
  });
});
