import { describe, it, expect } from "vitest";
import {
  chatSwipeStart,
  chatSwipeMove,
  chatSwipeDx,
  chatSwipeEnd,
  neighbour,
  COMMIT,
  type ChatSwipe,
} from "./chatSwipe";
import { EDGE_PX, SLOP_PX, HOLD_MS, FLICK } from "./swipe";

const W = 400;
const at = (x: number, y: number, t: number) => ({ x, y, t });

/** Start a gesture in the middle of the pane and walk it through some points. */
function run(first: { x: number; y: number; t: number }, ...rest: { x: number; y: number; t: number }[]) {
  let s = chatSwipeStart(first, { width: W });
  if (!s) return null;
  for (const p of rest) s = chatSwipeMove(s as ChatSwipe, p);
  return s;
}

describe("chatSwipeStart", () => {
  it("watches a touch that begins in the body of the pane", () => {
    expect(chatSwipeStart(at(200, 300, 0), { width: W })?.phase).toBe("watching");
  });

  it("leaves the left edge strip to the drawer", () => {
    expect(chatSwipeStart(at(EDGE_PX - 1, 300, 0), { width: W })).toBeNull();
  });

  it("leaves the right edge strip to the browser's own back gesture", () => {
    expect(chatSwipeStart(at(W - EDGE_PX + 1, 300, 0), { width: W })).toBeNull();
  });
});

describe("chatSwipeMove", () => {
  it("claims a finger that has gone far enough sideways", () => {
    expect(run(at(200, 300, 0), at(200 - SLOP_PX - 5, 300, 40))?.phase).toBe("swiping");
  });

  it("claims it in either direction, unlike the drawer", () => {
    expect(run(at(200, 300, 0), at(200 + SLOP_PX + 5, 300, 40))?.phase).toBe("swiping");
  });

  it("stays watching until the finger has cleared the slop", () => {
    expect(run(at(200, 300, 0), at(200 - SLOP_PX, 300, 40))?.phase).toBe("watching");
  });

  it("drops a finger going more up and down than across — the chat is scrolling", () => {
    expect(run(at(200, 300, 0), at(206, 300 - SLOP_PX - 5, 40))?.phase).toBe("dropped");
  });

  it("drops a finger that sat still first, because that is a highlight", () => {
    expect(run(at(200, 300, 0), at(120, 300, HOLD_MS + 1))?.phase).toBe("dropped");
  });

  it("never picks a dropped finger back up", () => {
    const s = run(at(200, 300, 0), at(206, 400, 40), at(60, 300, 80));
    expect(s?.phase).toBe("dropped");
  });
});

describe("chatSwipeDx", () => {
  it("is how far the finger has travelled, signed", () => {
    expect(chatSwipeDx(run(at(200, 300, 0), at(140, 300, 40)) as ChatSwipe)).toBe(-60);
    expect(chatSwipeDx(run(at(200, 300, 0), at(260, 300, 40)) as ChatSwipe)).toBe(60);
  });
});

describe("chatSwipeEnd", () => {
  it("means nothing when the gesture never became ours", () => {
    const s = run(at(200, 300, 0), at(206, 400, 40));
    expect(chatSwipeEnd(s as ChatSwipe)).toBeNull();
  });

  it("snaps back when the finger crawled and stopped short", () => {
    const short = W * COMMIT - 10;
    const s = run(at(300, 300, 0), at(300 - SLOP_PX - 5, 300, 200), at(300 - short, 300, 600));
    expect(chatSwipeEnd(s as ChatSwipe)).toBeNull();
  });

  it("goes to the next chat when the finger crossed enough of the pane leftwards", () => {
    const far = W * COMMIT + 20;
    const s = run(at(300, 300, 0), at(300 - SLOP_PX - 5, 300, 200), at(300 - far, 300, 600));
    expect(chatSwipeEnd(s as ChatSwipe)).toBe("next");
  });

  it("goes to the previous chat rightwards", () => {
    const far = W * COMMIT + 20;
    const s = run(at(100, 300, 0), at(100 + SLOP_PX + 5, 300, 200), at(100 + far, 300, 600));
    expect(chatSwipeEnd(s as ChatSwipe)).toBe("prev");
  });

  it("takes a short flick as meant, however little ground it covered", () => {
    const s = run(at(200, 300, 0), at(180, 300, 40), at(180 - FLICK * 20 - 5, 300, 60));
    expect(chatSwipeEnd(s as ChatSwipe)).toBe("next");
  });
});

describe("neighbour", () => {
  const ids = ["a", "b", "c"];

  it("walks down the list and wraps at the end", () => {
    expect(neighbour(ids, "a", "next")).toBe("b");
    expect(neighbour(ids, "c", "next")).toBe("a");
  });

  it("walks up the list and wraps at the start", () => {
    expect(neighbour(ids, "b", "prev")).toBe("a");
    expect(neighbour(ids, "a", "prev")).toBe("c");
  });

  it("has nowhere to go with one chat, or none", () => {
    expect(neighbour(["a"], "a", "next")).toBeNull();
    expect(neighbour([], null, "next")).toBeNull();
  });

  it("has nowhere to go from a chat that is not in the list", () => {
    expect(neighbour(ids, "zz", "next")).toBeNull();
    expect(neighbour(ids, null, "next")).toBeNull();
  });
});
