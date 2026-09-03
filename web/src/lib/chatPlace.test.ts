// Where a conversation was left. The point of the whole file is that coming
// back to a chat you were reading BACK through is not the same as opening one
// you are having.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  chatPlaceOf,
  forgetChatPlace,
  forgetChatPlaces,
  MAX_CHAT_PLACES,
  placeFrom,
  placeTop,
  rememberChatPlace,
  type Anchor,
} from "./chatPlace";

const real = globalThis.localStorage;

/** A working store, as a browser has. Kept out here so a test can look at what
 *  was actually written down. */
let held: Map<string, string>;

beforeEach(() => {
  held = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
    removeItem: (k: string) => void held.delete(k),
  });
  forgetChatPlaces();
});

afterEach(() => {
  vi.stubGlobal("localStorage", real);
});

describe("remembering where a chat was left", () => {
  it("hands the place back", () => {
    rememberChatPlace("c1", { top: 900, turn: "m7", delta: 120 });

    expect(chatPlaceOf("c1")).toEqual({ top: 900, turn: "m7", delta: 120 });
  });

  it("says nothing about a chat that was left at the bottom", () => {
    // Which is the whole of how "at the bottom" is recorded: by absence. There
    // is no place to keep in step with a conversation that is still growing.
    expect(chatPlaceOf("c1")).toBeUndefined();
  });

  it("forgets a chat that came back to the bottom", () => {
    rememberChatPlace("c1", { top: 900 });
    forgetChatPlace("c1");

    expect(chatPlaceOf("c1")).toBeUndefined();
  });

  it("keeps two chats apart", () => {
    rememberChatPlace("c1", { top: 10 });
    rememberChatPlace("c2", { top: 20 });

    expect(chatPlaceOf("c1")).toEqual({ top: 10 });
    expect(chatPlaceOf("c2")).toEqual({ top: 20 });
  });

  it("drops the chat left longest ago once it is full", () => {
    for (let i = 0; i <= MAX_CHAT_PLACES; i++) rememberChatPlace(`c${i}`, { top: i });

    expect(chatPlaceOf("c0")).toBeUndefined();
    expect(chatPlaceOf("c1")).toEqual({ top: 1 });
    expect(chatPlaceOf(`c${MAX_CHAT_PLACES}`)).toEqual({ top: MAX_CHAT_PLACES });
  });

  it("counts a chat you came back to as the newest, not the oldest", () => {
    for (let i = 0; i < MAX_CHAT_PLACES; i++) rememberChatPlace(`c${i}`, { top: i });
    rememberChatPlace("c0", { top: 999 });
    rememberChatPlace("new", { top: 1 });

    expect(chatPlaceOf("c0")).toEqual({ top: 999 });
    expect(chatPlaceOf("c1")).toBeUndefined();
  });
});

describe("across a reload", () => {
  it("reads back what the last page wrote", () => {
    rememberChatPlace("c1", { top: 900, turn: "m7", delta: 120 });

    // What a reload is, as far as this module can tell: the map is gone and
    // the store is not.
    forgetChatPlacesInMemoryOnly();

    expect(chatPlaceOf("c1")).toEqual({ top: 900, turn: "m7", delta: 120 });
  });

  it("survives a store that has been scribbled in", () => {
    held.set("octiq.v2.chatPlaces", "not json at all");
    forgetChatPlacesInMemoryOnly();

    expect(chatPlaceOf("c1")).toBeUndefined();
    // And still takes a new place afterwards, rather than being poisoned by it.
    rememberChatPlace("c1", { top: 5 });
    expect(chatPlaceOf("c1")).toEqual({ top: 5 });
  });

  it("keeps the good rows and drops the bad ones", () => {
    held.set(
      "octiq.v2.chatPlaces",
      JSON.stringify([
        ["c1", { top: 12 }],
        ["c2", { top: "half way" }],
        ["c3", null],
        [42, { top: 1 }],
        ["c4", { top: 30, turn: "m1", delta: 4 }],
      ]),
    );
    forgetChatPlacesInMemoryOnly();

    expect(chatPlaceOf("c1")).toEqual({ top: 12 });
    expect(chatPlaceOf("c2")).toBeUndefined();
    expect(chatPlaceOf("c3")).toBeUndefined();
    expect(chatPlaceOf("c4")).toEqual({ top: 30, turn: "m1", delta: 4 });
  });

  it("drops half an anchor rather than trusting it", () => {
    held.set("octiq.v2.chatPlaces", JSON.stringify([["c1", { top: 12, turn: "m1" }]]));
    forgetChatPlacesInMemoryOnly();

    // A turn with no delta cannot say where the view began, so the pixel
    // offset is the only honest half of it.
    expect(chatPlaceOf("c1")).toEqual({ top: 12 });
  });

  it("carries on when the store will not take a write", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {},
    });
    forgetChatPlacesInMemoryOnly();

    expect(() => rememberChatPlace("c1", { top: 5 })).not.toThrow();
    // The place holds for this page even though it will not outlive it — the
    // same promise `lib/remember` makes about every other setting.
    expect(chatPlaceOf("c1")).toEqual({ top: 5 });
  });
});

/** Throw away the in-memory map WITHOUT touching the store, which is what a
 *  reload does. `forgetChatPlaces` deliberately clears both. */
function forgetChatPlacesInMemoryOnly() {
  const kept = held.get("octiq.v2.chatPlaces");
  forgetChatPlaces();
  if (kept === undefined) held.delete("octiq.v2.chatPlaces");
  else held.set("octiq.v2.chatPlaces", kept);
}

describe("anchoring a place to a turn", () => {
  const anchors: readonly Anchor[] = [
    { id: "m1", offset: 0 },
    { id: "m2", offset: 1_000 },
    { id: "m3", offset: 4_000 },
  ];

  it("anchors to the last turn at or above the top of the view", () => {
    // Not the nearest one: what is being read sits UNDER that turn, so growth
    // inside the turns above must not move it.
    expect(placeFrom(1_200, anchors)).toEqual({ top: 1_200, turn: "m2", delta: 200 });
  });

  it("anchors to a turn the view begins exactly on", () => {
    expect(placeFrom(4_000, anchors)).toEqual({ top: 4_000, turn: "m3", delta: 0 });
  });

  it("keeps only the pixels when the reader is above the first turn", () => {
    expect(placeFrom(40, [{ id: "m1", offset: 300 }])).toEqual({ top: 40 });
  });

  it("keeps only the pixels when there are no turns to anchor to", () => {
    expect(placeFrom(40, [])).toEqual({ top: 40 });
  });

  it("does not care what order the anchors arrive in", () => {
    const shuffled = [anchors[2], anchors[0], anchors[1]];

    expect(placeFrom(1_200, shuffled)).toEqual({ top: 1_200, turn: "m2", delta: 200 });
  });
});

describe("going back to a place", () => {
  it("follows the turn rather than the pixels", () => {
    // The point of the anchor: everything above the turn grew by 500px while
    // the chat was closed, and the reader still lands on the same words.
    const place = placeFrom(1_200, [{ id: "m2", offset: 1_000 }]);
    const moved = [{ id: "m2", offset: 1_500 }];

    expect(placeTop(place, moved, 9_999)).toBe(1_700);
  });

  it("falls back to the pixels when the turn is gone", () => {
    // A compaction folded the history away — or the transcript is one frame
    // from being finished. Either way the offset is better than the top.
    const place = { top: 1_200, turn: "m2", delta: 200 };

    expect(placeTop(place, [{ id: "m9", offset: 0 }], 9_999)).toBe(1_200);
  });

  it("never asks for more scroll than there is", () => {
    expect(placeTop({ top: 9_000 }, [], 2_000)).toBe(2_000);
    expect(placeTop({ top: 9_000, turn: "m1", delta: 400 }, [{ id: "m1", offset: 8_000 }], 2_000)).toBe(2_000);
  });

  it("never asks for a negative scroll", () => {
    // A turn that has moved UP by more than the delta.
    expect(placeTop({ top: 300, turn: "m1", delta: 100 }, [{ id: "m1", offset: -900 }], 2_000)).toBe(0);
    // And a content box shorter than the viewport, whose max is negative.
    expect(placeTop({ top: 300 }, [], -50)).toBe(0);
  });
});
