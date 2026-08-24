import { describe, expect, it } from "vitest";
import { CatchUp } from "./catchUp";

const ev = (n: number) => ({ seq: n, event: { n } });

describe("where a catch-up starts", () => {
  it("starts from nothing for a chat this device has never held", () => {
    const c = new CatchUp();
    expect(c.begin("chat:a", undefined)).toBe(0);
  });

  it("starts from the stored mark for a chat this device saved", () => {
    const c = new CatchUp();
    expect(c.begin("chat:a", 16000)).toBe(16000);
  });

  it("is NOT moved by live events for a chat it does not hold", () => {
    // The bug: an agent talking in the background used to push the mark past
    // the whole transcript, so opening the chat asked for the tail and drew an
    // empty page.
    const c = new CatchUp();
    c.live("chat:a", 16200, {});
    expect(c.begin("chat:a", undefined)).toBe(0);
  });

  it("starts from the live mark once the chat is held", () => {
    const c = new CatchUp();
    c.end("chat:a", [ev(1), ev(2)]);
    c.live("chat:a", 3, {});
    expect(c.begin("chat:a", undefined)).toBe(3);
  });
});

describe("live events", () => {
  it("are folded for a chat this page holds", () => {
    const c = new CatchUp();
    c.end("chat:a", [ev(1)]);
    expect(c.live("chat:a", 2, { n: 2 })).toEqual([{ seq: 2, event: { n: 2 } }]);
  });

  it("are skipped when already folded", () => {
    const c = new CatchUp();
    c.end("chat:a", [ev(1), ev(2)]);
    expect(c.live("chat:a", 2, {})).toEqual([]);
  });

  it("are folded for a chat this page does not hold, but do not move the mark", () => {
    // Worth folding: it is what keeps the sidebar's working dot alive for a
    // chat nobody has opened. Not worth trusting: the conversation it lands in
    // has a hole where its past belongs, so the catch-up rebuilds it.
    const c = new CatchUp();
    expect(c.live("chat:a", 900, { n: 900 })).toEqual([{ seq: 900, event: { n: 900 } }]);
    expect(c.mark("chat:a")).toBe(0);
    expect(c.holds("chat:a")).toBe(false);
  });
});

describe("a live event racing the catch-up that would have carried it", () => {
  it("is folded after the replayed run, once, in order", () => {
    const c = new CatchUp();
    c.begin("chat:a", undefined);
    c.live("chat:a", 3, { n: 3 });
    expect(c.end("chat:a", [ev(1), ev(2)])).toEqual([
      { seq: 1, event: { n: 1 } },
      { seq: 2, event: { n: 2 } },
      { seq: 3, event: { n: 3 } },
    ]);
    expect(c.live("chat:a", 3, {})).toEqual([]);
  });

  it("is not folded twice when the run already carried it", () => {
    const c = new CatchUp();
    c.begin("chat:a", undefined);
    c.live("chat:a", 2, { n: 2 });
    expect(c.end("chat:a", [ev(1), ev(2)])).toEqual([
      { seq: 1, event: { n: 1 } },
      { seq: 2, event: { n: 2 } },
    ]);
  });
});

describe("a catch-up that did not land", () => {
  it("leaves the chat unheld, so the next open replays it in full", () => {
    const c = new CatchUp();
    c.begin("chat:a", undefined);
    c.live("chat:a", 5, {});
    c.abandon("chat:a");
    expect(c.holds("chat:a")).toBe(false);
    expect(c.begin("chat:a", undefined)).toBe(0);
  });
});

describe("a chat started on this page", () => {
  it("is held from its first event", () => {
    const c = new CatchUp();
    c.own("chat:a");
    expect(c.holds("chat:a")).toBe(true);
    expect(c.live("chat:a", 1, { n: 1 })).toEqual([{ seq: 1, event: { n: 1 } }]);
  });

  it("is held again from nothing after /clear drops the server's counter", () => {
    const c = new CatchUp();
    c.end("chat:a", [ev(1), ev(2), ev(3)]);
    c.own("chat:a");
    expect(c.live("chat:a", 1, { n: 1 })).toEqual([{ seq: 1, event: { n: 1 } }]);
  });
});

describe("the mark that is written back to storage", () => {
  it("is how far the page has actually read", () => {
    const c = new CatchUp();
    c.end("chat:a", [ev(1), ev(2)]);
    expect(c.mark("chat:a")).toBe(2);
  });

  it("is left alone by a chat the page does not hold", () => {
    const c = new CatchUp();
    c.live("chat:a", 900, {});
    expect(c.mark("chat:a")).toBe(0);
  });

  it("survives a catch-up that asked from where storage left off", () => {
    const c = new CatchUp();
    expect(c.begin("chat:a", 16000)).toBe(16000);
    expect(c.end("chat:a", [ev(16001)])).toEqual([{ seq: 16001, event: { n: 16001 } }]);
    expect(c.mark("chat:a")).toBe(16001);
  });
});
