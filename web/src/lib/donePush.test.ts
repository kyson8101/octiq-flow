import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatFilterList } from "./chatFilter";
import {
  COLLAPSE_MS, createDonePush, NO_PUSH, PUSH_DELAY_MS, PUSH_MS, pushCandidates, withoutPushed,
  type DonePush, type DonePushView,
} from "./donePush";
import type { Conversation } from "./store";

function chat(id: string, updatedAt: number, doneAt?: number | null, pinned = false): Conversation {
  return { id, projectId: "p", title: id, messages: [], createdAt: 0, updatedAt, pinned, ...(doneAt === undefined ? {} : { doneAt }) } as Conversation;
}

let views: DonePushView[];
let gone: string[];
let engine: DonePush;

const look = (chats: Record<string, boolean>, watching = true) =>
  engine.sync({ watching, chats: new Map(Object.entries(chats)) });
const last = () => views[views.length - 1] ?? NO_PUSH;

beforeEach(() => {
  vi.useFakeTimers();
  views = [];
  gone = [];
  engine = createDonePush({ onGone: (id) => gone.push(id) }, (view) => views.push(view));
});
afterEach(() => {
  engine.dispose();
  vi.useRealTimers();
});

describe("a chat that becomes done", () => {
  it("starts leaving at 3 s, then collapses, then is gone", () => {
    look({ a: false, b: false });
    look({ a: true, b: false });
    vi.advanceTimersByTime(PUSH_DELAY_MS - 1);
    expect(last().phases.size).toBe(0);
    vi.advanceTimersByTime(1);
    expect(last().phases.get("a")).toBe("pushing");
    expect(last().phases.has("b")).toBe(false);
    vi.advanceTimersByTime(PUSH_MS);
    expect(last().phases.get("a")).toBe("collapsing");
    expect(last().gone.size).toBe(0);
    vi.advanceTimersByTime(COLLAPSE_MS);
    expect(last().phases.size).toBe(0);
    expect([...last().gone]).toEqual(["a"]);
    expect(gone).toEqual(["a"]);
  });

  it("keeps its original start across repeated looks", () => {
    look({ a: false });
    look({ a: true });
    vi.advanceTimersByTime(2000);
    look({ a: true });
    vi.advanceTimersByTime(1000);
    expect(last().phases.get("a")).toBe("pushing");
  });
});

describe("cancelling", () => {
  it("a new message at 2 s (done no more) leaves it alone", () => {
    look({ a: false });
    look({ a: true });
    vi.advanceTimersByTime(2000);
    look({ a: false });
    vi.advanceTimersByTime(10_000);
    expect(last().phases.size).toBe(0);
    expect(last().gone.size).toBe(0);
    expect(gone).toEqual([]);
  });

  it("an untick mid-push stops it and a later tick starts over", () => {
    look({ a: false });
    look({ a: true });
    vi.advanceTimersByTime(PUSH_DELAY_MS + 100);
    expect(last().phases.get("a")).toBe("pushing");
    look({ a: false });
    expect(last().phases.size).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(gone).toEqual([]);
    look({ a: true });
    vi.advanceTimersByTime(PUSH_DELAY_MS);
    expect(last().phases.get("a")).toBe("pushing");
  });

  it("an untick after it left brings the row back into the filter's hands", () => {
    look({ a: false });
    look({ a: true });
    vi.advanceTimersByTime(PUSH_DELAY_MS + PUSH_MS + COLLAPSE_MS);
    expect(last().gone.has("a")).toBe(true);
    look({ a: false });
    expect(last().gone.size).toBe(0);
  });

  it("leaving the Active view cancels every pending row", () => {
    look({ a: false, b: false });
    look({ a: true, b: true });
    vi.advanceTimersByTime(1000);
    look({ a: true, b: true }, false);
    vi.advanceTimersByTime(10_000);
    expect(last().phases.size).toBe(0);
    expect(gone).toEqual([]);
  });

  it("a pinned or deleted chat (no longer a candidate) is dropped", () => {
    look({ a: false });
    look({ a: true });
    vi.advanceTimersByTime(1000);
    look({});
    vi.advanceTimersByTime(10_000);
    expect(gone).toEqual([]);
  });

  it("dispose clears every timer", () => {
    look({ a: false, b: false });
    look({ a: true, b: true });
    engine.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(gone).toEqual([]);
  });

  it("holds one timer per row", () => {
    look({ a: false, b: false, c: false });
    look({ a: true, b: true, c: false });
    expect(vi.getTimerCount()).toBe(2);
    look({ a: true, b: true, c: false });
    expect(vi.getTimerCount()).toBe(2);
  });
});

describe("a row stays listed while it waits and while it leaves", () => {
  it("is held from the tick until it has gone, whoever ticked it", () => {
    look({ a: false, b: false });
    expect([...engine.pending({ watching: true, chats: new Map([["a", true], ["b", false]]) })]).toEqual(["a"]);
    look({ a: true, b: false });
    expect([...last().held]).toEqual(["a"]);
    vi.advanceTimersByTime(PUSH_DELAY_MS);
    expect([...last().held]).toEqual(["a"]);
    vi.advanceTimersByTime(PUSH_MS);
    expect([...last().held]).toEqual(["a"]);
    vi.advanceTimersByTime(COLLAPSE_MS);
    expect(last().held.size).toBe(0);
    expect(last().gone.has("a")).toBe(true);
  });

  it("is released again by an untick or a new message", () => {
    look({ a: false });
    look({ a: true });
    expect(last().held.has("a")).toBe(true);
    look({ a: false });
    expect(last().held.size).toBe(0);
  });

  it("pending is empty once the engine has started the row, and when not watching", () => {
    look({ a: false });
    const done = new Map([["a", true]]);
    expect(engine.pending({ watching: false, chats: done }).size).toBe(0);
    look({ a: true });
    expect(engine.pending({ watching: true, chats: done }).size).toBe(0);
  });

  it("the Active filter keeps a remotely ticked row until it has gone", () => {
    const list = [chat("a", 100, 100), chat("b", 100)];
    const held = withoutPushed(null, new Set(), NO_PUSH.gone, new Set(["a"]));
    expect(chatFilterList(list, "active", held.keep, held.keepMarked).map((c) => c.id)).toEqual(["a", "b"]);
    const left = withoutPushed(null, new Set(), new Set(["a"]), new Set());
    expect(chatFilterList(list, "active", left.keep, left.keepMarked).map((c) => c.id)).toEqual(["b"]);
  });
});

describe("a row that has gone stays out of Active", () => {
  const leave = () => {
    look({ a: false });
    look({ a: true });
    vi.advanceTimersByTime(PUSH_DELAY_MS + PUSH_MS + COLLAPSE_MS);
    expect(last().gone.has("a")).toBe(true);
  };

  it("through All → Done → Active, not animated again", () => {
    leave();
    look({ a: true }, false);
    expect(last().gone.has("a")).toBe(true);
    look({ a: true });
    expect(last().gone.has("a")).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(gone).toEqual(["a"]);
  });

  it("until it is not done any more, even while another view is showing", () => {
    leave();
    look({ a: false }, false);
    expect(last().gone.size).toBe(0);
  });

  it("leaving the view mid-push still cancels the push", () => {
    look({ a: false });
    look({ a: true });
    vi.advanceTimersByTime(PUSH_DELAY_MS + 100);
    look({ a: true }, false);
    expect(last().phases.size).toBe(0);
    expect(last().held.size).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(gone).toEqual([]);
  });
});

describe("the kept set keeps its identity", () => {
  it("is the caller's own set while held and gone add nothing new", () => {
    const marked: ReadonlySet<string> = new Set(["c"]);
    expect(withoutPushed(null, marked, new Set(), new Set(["c"])).keepMarked).toBe(marked);
    expect(withoutPushed(null, marked, new Set(["x"]), new Set()).keepMarked).toBe(marked);
  });
});

describe("only what this page watched becoming done", () => {
  it("a chat already done at load is never animated", () => {
    look({ a: true, b: false });
    vi.advanceTimersByTime(60_000);
    expect(views).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returning to Active re-learns the baseline instead of animating", () => {
    look({ a: false });
    look({ a: false }, false);
    look({ a: true });
    vi.advanceTimersByTime(60_000);
    expect(gone).toEqual([]);
  });

  it("a chat that first turns up already done is not animated", () => {
    look({ a: false });
    look({ a: false, fresh: true });
    vi.advanceTimersByTime(60_000);
    expect(gone).toEqual([]);
  });

  it("an unanswered list is not a baseline", () => {
    look({}, false);
    look({ a: true });
    look({ a: true });
    vi.advanceTimersByTime(60_000);
    expect(gone).toEqual([]);
  });
});

describe("the open chat", () => {
  const open = "a";
  const list = [chat("a", 100, 100), chat("b", 100), chat("c", 100, 100)];

  it("is held in Active by being open, until its row has left", () => {
    expect(chatFilterList(list, "active", open).map((c) => c.id)).toEqual(["a", "b"]);
    const { keep, keepMarked } = withoutPushed(open, new Set(), new Set(["a"]));
    expect(keep).toBeNull();
    expect(chatFilterList(list, "active", keep, keepMarked).map((c) => c.id)).toEqual(["b"]);
  });

  it("only the row is released: the open chat id is untouched in the caller", () => {
    const marked: ReadonlySet<string> = new Set(["c", "x"]);
    const effective = withoutPushed("b", marked, new Set(["c"]));
    expect(effective.keep).toBe("b");
    expect([...effective.keepMarked]).toEqual(["x"]);
    expect([...marked]).toEqual(["c", "x"]);
  });

  it("changes nothing while nothing has left", () => {
    const marked: ReadonlySet<string> = new Set(["c"]);
    expect(withoutPushed("a", marked, new Set())).toEqual({ keep: "a", keepMarked: marked });
  });

  it("a new message brings the chat back", () => {
    const { keep, keepMarked } = withoutPushed(open, new Set(), new Set(["a"]));
    const messaged = [chat("a", 500, 100), ...list.slice(1)];
    expect(chatFilterList(messaged, "active", keep, keepMarked).map((c) => c.id)).toContain("a");
  });
});

describe("pushCandidates", () => {
  it("leaves out pinned chats and reads done from the tick", () => {
    const found = pushCandidates([chat("a", 100, 100), chat("b", 100), chat("p", 100, 100, true)]);
    expect([...found]).toEqual([["a", true], ["b", false]]);
  });
});
