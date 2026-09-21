import { describe, it, expect } from "vitest";
import {
  swipeStart,
  swipeMove,
  swipeProgress,
  swipeEnd,
  EDGE_PX,
  SLOP_PX,
  DRAWER_CLAIM_PX,
  DRAWER_FLICK_MIN_PX,
  HOLD_MS,
  type Swipe,
} from "./swipe";

const W = 300;
const at = (x: number, y: number, t: number) => ({ x, y, t });

/** Start a gesture and walk it through a list of points. */
function run(open: boolean, first: { x: number; y: number; t: number }, ...rest: { x: number; y: number; t: number }[]) {
  let s = swipeStart(first, { open, width: W });
  if (!s) return null;
  for (const p of rest) s = swipeMove(s as Swipe, p);
  return s;
}

describe("swipeStart", () => {
  it("ignores a touch that begins away from the edge while the drawer is closed", () => {
    expect(swipeStart(at(EDGE_PX + 1, 300, 0), { open: false, width: W })).toBeNull();
  });

  it("watches a touch that begins inside the edge strip", () => {
    const s = swipeStart(at(EDGE_PX - 1, 300, 0), { open: false, width: W });
    expect(s?.phase).toBe("watching");
    expect(s?.opening).toBe(true);
  });

  it("watches a touch anywhere once the drawer is open, as a close", () => {
    const s = swipeStart(at(200, 300, 0), { open: true, width: W });
    expect(s?.phase).toBe("watching");
    expect(s?.opening).toBe(false);
  });
});

describe("swipeMove", () => {
  it("drops a mostly-vertical drag, so the page still scrolls", () => {
    const s = run(false, at(10, 300, 0), at(14, 260, 60));
    expect(s?.phase).toBe("dropped");
  });

  it("commits to the swipe once the finger reaches the drawer claim distance", () => {
    const s = run(false, at(10, 300, 0), at(10 + DRAWER_CLAIM_PX, 302, 60));
    expect(s?.phase).toBe("swiping");
  });

  it("keeps a short horizontal thumb drift below the drawer claim threshold", () => {
    const s = run(false, at(5, 300, 0), at(5 + SLOP_PX + 2, 302, 30));
    expect(s?.phase).toBe("watching");
  });

  it("drops a near-diagonal edge drag instead of stealing a scroll", () => {
    const s = run(false, at(5, 300, 0), at(5 + DRAWER_CLAIM_PX + 2, 319, 60));
    expect(s?.phase).toBe("dropped");
  });

  it("drops a finger that sat still first — that is a selection, not a swipe", () => {
    const s = run(false, at(10, 300, 0), at(12, 301, HOLD_MS + 50), at(60, 301, HOLD_MS + 90));
    expect(s?.phase).toBe("dropped");
  });

  it("drops a leftward drag from the closed edge", () => {
    const s = run(false, at(10, 300, 0), at(10 - DRAWER_CLAIM_PX, 300, 60));
    expect(s?.phase).toBe("dropped");
  });

  it("drops a rightward drag while the drawer is already open", () => {
    const s = run(true, at(200, 300, 0), at(200 + DRAWER_CLAIM_PX, 300, 60));
    expect(s?.phase).toBe("dropped");
  });
});

describe("swipeProgress", () => {
  it("follows the finger while opening and clamps at both ends", () => {
    const s = run(false, at(0, 300, 0), at(DRAWER_CLAIM_PX, 300, 40), at(150, 300, 80)) as Swipe;
    expect(swipeProgress(s)).toBeCloseTo(0.5, 2);
    expect(swipeProgress(swipeMove(s, at(900, 300, 120)))).toBe(1);
  });

  it("counts down from one while closing", () => {
    const s = run(true, at(200, 300, 0), at(200 - DRAWER_CLAIM_PX, 300, 40), at(50, 300, 80)) as Swipe;
    expect(swipeProgress(s)).toBeCloseTo(0.5, 2);
  });
});

describe("swipeEnd", () => {
  it("says nothing for a gesture that never committed", () => {
    const s = run(false, at(10, 300, 0), at(12, 260, 40)) as Swipe;
    expect(swipeEnd(s)).toBeNull();
  });

  it("opens when the finger crossed enough of the drawer", () => {
    const s = run(false, at(0, 300, 0), at(40, 300, 60), at(200, 300, 400)) as Swipe;
    expect(swipeEnd(s)).toBe("open");
  });

  it("snaps back shut when it did not", () => {
    const s = run(false, at(0, 300, 0), at(40, 300, 60), at(50, 300, 400)) as Swipe;
    expect(swipeEnd(s)).toBe("close");
  });

  it("opens on a deliberate flick", () => {
    const s = run(false, at(0, 300, 0), at(DRAWER_FLICK_MIN_PX + 8, 300, 80)) as Swipe;
    expect(swipeEnd(s)).toBe("open");
  });

  it("does not open on a tiny fast twitch", () => {
    const s = run(false, at(0, 300, 0), at(DRAWER_CLAIM_PX + 6, 300, 20)) as Swipe;
    expect(swipeEnd(s)).toBe("close");
  });

  it("uses the whole gesture instead of release jitter as flick velocity", () => {
    const s = run(false, at(0, 300, 0), at(50, 300, 300), at(55, 300, 301)) as Swipe;
    expect(swipeEnd(s)).toBe("close");
  });

  it("closes when the finger took most of the drawer back", () => {
    const s = run(true, at(280, 300, 0), at(240, 300, 60), at(60, 300, 400)) as Swipe;
    expect(swipeEnd(s)).toBe("close");
  });

  it("leaves it open when the close was a nudge", () => {
    const s = run(true, at(280, 300, 0), at(240, 300, 60), at(250, 300, 400)) as Swipe;
    expect(swipeEnd(s)).toBe("open");
  });
});
