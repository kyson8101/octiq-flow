import { describe, expect, it } from "vitest";
import { BAR_SEEN_KEY, barSeen, cutEdges, holdsBar, overflowing, type Sized } from "./actionBar";

const GAP = 2;
const MORE = 68;
const item = (id: string, keep: number, width = 80): Sized => ({ id, keep, width });
/** The room `items` take in a row, with More after them when `more`. */
const room = (items: Sized[], more = false) =>
  items.reduce((sum, each) => sum + each.width, 0) + GAP * Math.max(0, items.length - 1) + (more ? GAP + MORE : 0);

describe("which actions go behind More", () => {
  const bar = [item("tasks", 100), item("preview", 90), item("git", 85), item("copy", 20), item("delete", 10)];

  it("puts nothing away while everything fits, to the pixel", () => {
    expect(overflowing(bar, room(bar), GAP, MORE)).toEqual([]);
    expect(overflowing(bar, 5000, GAP, MORE)).toEqual([]);
  });

  it("puts the lowest priority away first, and only as many as it must", () => {
    // One pixel short: More needs a place too, so one button is not enough.
    expect(overflowing(bar, room(bar) - 1, GAP, MORE)).toEqual(["delete"]);
    expect(overflowing(bar, room(bar.slice(0, 3), true), GAP, MORE)).toEqual(["copy", "delete"]);
    expect(overflowing(bar, room(bar.slice(0, 3), true) - 1, GAP, MORE)).toEqual(["git", "copy", "delete"]);
  });

  it("answers in the bar's order whatever order they left in", () => {
    const mixed = [item("a", 10), item("b", 90), item("c", 5), item("d", 80)];
    expect(overflowing(mixed, room([mixed[1], mixed[3]], true), GAP, MORE)).toEqual(["a", "c"]);
  });

  it("takes the later of two equals first", () => {
    const equal = [item("first", 50), item("second", 50), item("third", 50)];
    expect(overflowing(equal, room(equal.slice(0, 2), true), GAP, MORE)).toEqual(["third"]);
  });

  it("never puts away a button that draws nothing, and gives it no room or gap", () => {
    const withEmpty = [item("tasks", 100), item("agents", 60, 0), item("pinned", 60, 0), item("delete", 10)];
    expect(overflowing(withEmpty, room([withEmpty[0], withEmpty[3]]), GAP, MORE)).toEqual([]);
    expect(overflowing(withEmpty, room([withEmpty[0], withEmpty[3]]) - 1, GAP, MORE)).toEqual(["delete"]);
  });

  it("puts everything behind More when even the last button has no room beside it", () => {
    expect(overflowing(bar, 60, GAP, MORE)).toEqual(bar.map((each) => each.id));
    expect(overflowing([], 0, GAP, MORE)).toEqual([]);
  });

  it("is steady: what it leaves in the row fits beside More, so the next measure agrees", () => {
    for (let width = 0; width <= room(bar) + 4; width += 1) {
      const gone = overflowing(bar, width, GAP, MORE);
      const kept = bar.filter((each) => !gone.includes(each.id));
      if (gone.length && kept.length) expect(room(kept, true)).toBeLessThanOrEqual(width);
      // Measured again with the same widths, the answer is the same.
      expect(overflowing(bar, width, GAP, MORE)).toEqual(gone);
    }
  });

  it("goes by the widths it is given: a wider font puts more away at the same window", () => {
    const wide = bar.map((each) => ({ ...each, width: each.width * 1.3 }));
    const window = room(bar);
    expect(overflowing(bar, window, GAP, MORE)).toEqual([]);
    expect(overflowing(wide, window, GAP, MORE).length).toBeGreaterThan(0);
  });
});

describe("which edge of a phone's row is cut", () => {
  it("is cut at neither end when everything is in view", () => {
    expect(cutEdges(0, 390, 390)).toBe("");
    expect(cutEdges(0, 390.6, 390)).toBe("");
  });

  it("is cut at the end before any scroll, at both ends midway, at the start when at the end", () => {
    expect(cutEdges(0, 800, 390)).toBe("end");
    expect(cutEdges(120, 800, 390)).toBe("start end");
    expect(cutEdges(410, 800, 390)).toBe("start");
    // A scaled display stops a fraction short of the end.
    expect(cutEdges(409.4, 800, 390)).toBe("start");
  });

  it("reads a right-to-left scroller, whose position counts down from zero", () => {
    expect(cutEdges(-120, 800, 390)).toBe("start end");
  });
});

describe("whether a chat's page keeps the bar's row before it has a button", () => {
  const page = { onChat: true, actions: 0, loaded: false, chat: false, arriving: false, remembered: false };

  it("never draws the row for a first run with no project, before the list answers or after", () => {
    // Nothing says buttons are coming: no chat open or named, and this
    // browser has never seen a chat's page with any. The row was held here
    // for the project list and taken away when it answered empty: 36px.
    expect(holdsBar(page)).toBe(false);
    expect(holdsBar({ ...page, loaded: true })).toBe(false);
    expect(barSeen({ ...page, loaded: true })).toBe("0");
  });

  it("holds the row from the first paint when a chat is known", () => {
    expect(holdsBar({ ...page, chat: true })).toBe(true);
    expect(holdsBar({ ...page, chat: true, arriving: true })).toBe(true);
    // A linked chat still on its way keeps it after the list has answered.
    expect(holdsBar({ ...page, loaded: true, chat: true, arriving: true })).toBe(true);
  });

  it("holds it when this browser's last visit had buttons", () => {
    expect(holdsBar({ ...page, remembered: true })).toBe(true);
    // And gives it back once when the page has lost them all since.
    expect(holdsBar({ ...page, remembered: true, loaded: true })).toBe(false);
    expect(barSeen({ ...page, loaded: true })).toBe("0");
  });

  it("is there for the buttons the page has", () => {
    expect(holdsBar({ ...page, actions: 2 })).toBe(true);
    expect(holdsBar({ ...page, actions: 2, loaded: true })).toBe(true);
    expect(barSeen({ ...page, actions: 2, loaded: true })).toBe("1");
  });

  it("is never held by a page that is not a chat's", () => {
    for (const other of [page, { ...page, actions: 3 }, { ...page, chat: true, remembered: true }]) {
      expect(holdsBar({ ...other, onChat: false })).toBe(false);
    }
  });

  it("remembers nothing until the answer is known", () => {
    expect(barSeen({ ...page, actions: 2 })).toBeNull();
    expect(barSeen({ ...page, loaded: true, arriving: true })).toBeNull();
    expect(barSeen({ ...page, onChat: false, loaded: true, actions: 2 })).toBeNull();
    expect(BAR_SEEN_KEY).toBe("octiq.v2.actionBar");
  });
});
