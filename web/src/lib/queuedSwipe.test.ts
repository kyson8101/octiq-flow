import { describe, expect, it } from "vitest";
import { HOLD_MS } from "./swipe";
import { queuedSwipeEnd, queuedSwipeMove, queuedSwipeOffset, queuedSwipeStart } from "./queuedSwipe";

const point = (x: number, y = 100, t = 0) => ({ x, y, t });
const begin = (open = false, width = 160) => queuedSwipeStart(point(220), width, open);

describe("queued message swipe", () => {
  it("reveals the tray leftwards and closes it rightwards", () => {
    const opening = queuedSwipeMove(begin(), point(100, 100, 200));
    expect(queuedSwipeOffset(opening)).toBe(120);
    expect(queuedSwipeEnd(opening, 400)).toBe(true);
    const closing = queuedSwipeMove(begin(true), point(340, 100, 200));
    expect(queuedSwipeOffset(closing)).toBe(40);
    expect(queuedSwipeEnd(closing, 400)).toBe(false);
  });

  it("ignores taps and movements in the unavailable direction", () => {
    expect(queuedSwipeMove(begin(), point(225, 101, 100)).phase).toBe("watching");
    expect(queuedSwipeMove(begin(), point(250, 100, 100)).phase).toBe("dropped");
    expect(queuedSwipeMove(begin(true), point(190, 100, 100)).phase).toBe("dropped");
    expect(queuedSwipeEnd(begin(true), 200)).toBe(true);
  });

  it("leaves vertical and diagonal scrolling alone", () => {
    const vertical = queuedSwipeMove(begin(), point(210, 140, 100));
    expect(vertical.phase).toBe("dropped");
    expect(queuedSwipeMove(vertical, point(80, 145, 200)).phase).toBe("dropped");
    expect(queuedSwipeMove(begin(), point(200, 125, 100)).phase).toBe("dropped");
    expect(queuedSwipeMove(begin(), point(205, 114, 100)).phase).toBe("watching");
  });

  it("leaves a long press available for text selection", () => {
    const held = queuedSwipeMove(begin(), point(80, 100, HOLD_MS + 1));
    expect(held.phase).toBe("dropped");
    expect(queuedSwipeEnd(held, HOLD_MS + 10)).toBe(false);
  });

  it("snaps a small drag shut and a short flick open", () => {
    const short = queuedSwipeMove(begin(), point(190, 100, 200));
    expect(queuedSwipeEnd(short, 400)).toBe(false);
    const flick = queuedSwipeMove(begin(), point(190, 100, 40));
    expect(queuedSwipeEnd(flick, 45)).toBe(true);
  });

  it("does not count stale velocity after the finger has stopped", () => {
    const flickThenHold = queuedSwipeMove(begin(), point(190, 100, 40));
    expect(queuedSwipeEnd(flickThenHold, 250)).toBe(false);
  });

  it("lets a last-moment reversal close an almost revealed tray", () => {
    const left = queuedSwipeMove(begin(), point(60, 100, 200));
    const right = queuedSwipeMove(left, point(90, 100, 220));
    expect(queuedSwipeOffset(right)).toBe(130);
    expect(queuedSwipeEnd(right, 225)).toBe(false);
  });

  it("clamps travel to the available actions, including a single action", () => {
    expect(queuedSwipeOffset(queuedSwipeMove(begin(), point(-200, 100, 100)))).toBe(160);
    expect(queuedSwipeOffset(queuedSwipeMove(begin(true), point(600, 100, 100)))).toBe(0);
    const single = queuedSwipeMove(begin(false, 80), point(180, 100, 200));
    expect(queuedSwipeEnd(single, 400)).toBe(true);
    expect(queuedSwipeOffset(queuedSwipeMove(single, point(-20, 100, 300)))).toBe(80);
  });
});
