// Dismissing a failure banner for good. The point of the file is that a chat's
// state is replayed from its transcript, so "cleared" and "dismissed" are two
// different things — and that dismissing THIS failure is not dismissing the
// next one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeFailure } from "./chat";
import {
  dismissFailure,
  failureDismissed,
  failureMark,
  forgetDismissedFailure,
  forgetDismissedFailures,
  MAX_DISMISSED_FAILURES,
} from "./failureDismiss";

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
  forgetDismissedFailures();
});

afterEach(() => {
  vi.stubGlobal("localStorage", real);
});

const quota = describeFailure(
  "claude",
  "Claude AI usage limit reached. Please try again at Aug 20th, 2026 11:37 AM.",
);

describe("dismissing a failure", () => {
  it("keeps it dismissed", () => {
    expect(failureDismissed("c1", quota)).toBe(false);
    dismissFailure("c1", quota);
    expect(failureDismissed("c1", quota)).toBe(true);
  });

  it("survives the page being reloaded", () => {
    dismissFailure("c1", quota);
    // What a reload is: the module's memory goes, the store stays.
    forgetDismissedFailures();
    held.set(
      "octiq.v2.dismissedFailures",
      JSON.stringify([["c1", failureMark(quota)]]),
    );
    expect(failureDismissed("c1", quota)).toBe(true);
  });

  it("survives the chat being rebuilt under it", () => {
    dismissFailure("c1", quota);
    // What a catch-up after an idle reconnect does: the transcript is replayed
    // from zero and the same `result` event produces a brand new Failure
    // object. Nothing of the first one is left to compare against but its
    // words, which is exactly what the mark is made of.
    const rebuilt = describeFailure(
      "claude",
      "Claude AI usage limit reached. Please try again at Aug 20th, 2026 11:37 AM.",
    );
    expect(rebuilt).not.toBe(quota);
    expect(failureDismissed("c1", rebuilt)).toBe(true);
  });

  it("says nothing about another chat", () => {
    dismissFailure("c1", quota);
    expect(failureDismissed("c2", quota)).toBe(false);
  });

  it("lets a fresh limit through", () => {
    dismissFailure("c1", quota);
    const later = describeFailure(
      "claude",
      "Claude AI usage limit reached. Please try again at Aug 21st, 2026 9:00 AM.",
    );
    expect(failureDismissed("c1", later)).toBe(false);
  });

  it("lets a different failure through", () => {
    dismissFailure("c1", quota);
    expect(failureDismissed("c1", describeFailure("claude", "ENOENT: no such file"))).toBe(false);
  });

  it("holds one mark per chat — the last one dismissed", () => {
    const other = describeFailure("claude", "ENOENT: no such file");
    dismissFailure("c1", quota);
    dismissFailure("c1", other);
    expect(failureDismissed("c1", other)).toBe(true);
    expect(failureDismissed("c1", quota)).toBe(false);
  });

  it("forgets one on request", () => {
    dismissFailure("c1", quota);
    forgetDismissedFailure("c1");
    expect(failureDismissed("c1", quota)).toBe(false);
  });
});

describe("the store", () => {
  it("drops the oldest chat past the cap, and keeps the newest", () => {
    for (let i = 0; i < MAX_DISMISSED_FAILURES + 5; i++) {
      dismissFailure(`c${i}`, quota);
    }
    expect(failureDismissed("c0", quota)).toBe(false);
    expect(failureDismissed("c4", quota)).toBe(false);
    expect(failureDismissed("c5", quota)).toBe(true);
    expect(failureDismissed(`c${MAX_DISMISSED_FAILURES + 4}`, quota)).toBe(true);
  });

  it("keeps a chat that is dismissed again from ageing out", () => {
    dismissFailure("keeper", quota);
    for (let i = 0; i < MAX_DISMISSED_FAILURES - 1; i++) dismissFailure(`c${i}`, quota);
    dismissFailure("keeper", quota);
    for (let i = 0; i < 10; i++) dismissFailure(`d${i}`, quota);
    expect(failureDismissed("keeper", quota)).toBe(true);
  });

  it("shrugs off a stored value that is not JSON", () => {
    held.set("octiq.v2.dismissedFailures", "half a wri");
    forgetDismissedFailures();
    held.set("octiq.v2.dismissedFailures", "half a wri");
    expect(failureDismissed("c1", quota)).toBe(false);
    // And the next write replaces it.
    dismissFailure("c1", quota);
    expect(failureDismissed("c1", quota)).toBe(true);
  });

  it("never throws when storage is blocked outright", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    forgetDismissedFailures();
    expect(() => dismissFailure("c1", quota)).not.toThrow();
    // It holds for this visit, which is all a blocked store can offer.
    expect(failureDismissed("c1", quota)).toBe(true);
  });
});
