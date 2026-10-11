import { describe, expect, it } from "vitest";
import type { Ask } from "../components/PermissionAsk";
import { askDeadline, askRemaining, askWaitSecs, clockText, keepArrivals, stampArrival } from "./askClock";

const ask = (extra: Partial<Ask> = {}): Ask => ({ id: "a1", chatKey: "chat:c1", ...extra });

describe("clockText", () => {
  it("writes seconds as minutes and two digits of seconds", () => {
    expect(clockText(180)).toBe("3:00");
    expect(clockText(161)).toBe("2:41");
    expect(clockText(60)).toBe("1:00");
    expect(clockText(9)).toBe("0:09");
    expect(clockText(0)).toBe("0:00");
  });

  it("never goes below zero", () => {
    expect(clockText(-5)).toBe("0:00");
    expect(clockText(59.9)).toBe("0:59");
  });
});

describe("the wait the host gives a question", () => {
  it("is three minutes unless the host says less", () => {
    expect(askWaitSecs(ask())).toBe(180);
    expect(askWaitSecs(ask({ answerWithinSecs: 50 }))).toBe(50);
    expect(askWaitSecs(ask({ answerWithinSecs: 0 }))).toBe(180);
  });

  it("is never more than the host's own ceiling", () => {
    // `permission.rs` clamps a longer wait to three minutes; a clock that
    // believed the larger number would promise time the host will not give.
    expect(askWaitSecs(ask({ answerWithinSecs: 600 }))).toBe(180);
  });
});

describe("askDeadline and askRemaining", () => {
  it("count from when the page saw the question arrive", () => {
    const seen = ask({ receivedAt: 10_000 });
    expect(askDeadline(seen)).toBe(190_000);
    expect(askRemaining(seen, 10_000)).toBe(180);
    expect(askRemaining(seen, 29_000)).toBe(161);
    expect(askRemaining(ask({ receivedAt: 10_000, answerWithinSecs: 50 }), 40_000)).toBe(20);
  });

  it("round down, so the figure may run short of the host's and never long", () => {
    expect(askRemaining(ask({ receivedAt: 10_000 }), 10_001)).toBe(179);
    expect(askRemaining(ask({ receivedAt: 10_000 }), 189_999)).toBe(0);
  });

  it("stop at zero, and at the host's wait if this machine's clock stepped back", () => {
    expect(askRemaining(ask({ receivedAt: 10_000 }), 999_000)).toBe(0);
    expect(askRemaining(ask({ receivedAt: 10_000, answerWithinSecs: 50 }), 0)).toBe(50);
  });

  it("have nothing to say about a question nobody here saw arrive", () => {
    // Read back from `permission_pending` after a reload: its age is unknown,
    // and a clock started now would outlast the host's.
    expect(askDeadline(ask())).toBeNull();
    expect(askRemaining(ask(), 10_000)).toBeNull();
  });
});

describe("stamping an arrival", () => {
  it("stamps a live question with the time it arrived", () => {
    expect(stampArrival(ask(), {}, 5_000)).toEqual(ask({ receivedAt: 5_000 }));
  });

  it("keeps the first stamp when the same question is announced again", () => {
    const known = { c1: [ask({ receivedAt: 5_000 })] };
    expect(stampArrival(ask(), known, 90_000).receivedAt).toBe(5_000);
    // A different question in the same chat is its own three minutes.
    expect(stampArrival(ask({ id: "a2" }), known, 90_000).receivedAt).toBe(90_000);
  });

  it("carries a known arrival through the host's list, and invents none", () => {
    const known = { c1: [ask({ receivedAt: 5_000 })] };
    const list = [ask({ toolName: "Bash" }), ask({ id: "a2" })];
    expect(keepArrivals(list, known)).toEqual([ask({ toolName: "Bash", receivedAt: 5_000 }), ask({ id: "a2" })]);
    expect(keepArrivals(list, {})).toEqual(list);
    expect(keepArrivals(null, known)).toEqual([]);
  });
});
