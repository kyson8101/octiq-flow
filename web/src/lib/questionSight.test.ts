// Whether the questions waiting in the transcript can be seen. The observer
// is the browser's; what is counted from its reports is here.
import { describe, expect, it, vi } from "vitest";

import { hasHiddenDecisions, hiddenNow, hiddenQuestions, revealWaiting, subscribeSight, watchBlock } from "./questionSight";

describe("the questions waiting out of view", () => {
  it("counts the questions of every block that is out of view", () => {
    expect(hiddenQuestions([{ count: 1, seen: false }, { count: 3, seen: false }, { count: 2, seen: true }])).toBe(4);
  });

  it("counts none while every block is on screen", () => {
    expect(hiddenQuestions([{ count: 2, seen: true }])).toBe(0);
    expect(hiddenQuestions([])).toBe(0);
  });

  it("does not count a block before it has been looked at", () => {
    // The row above the composer must not flash up for the frame between a
    // block mounting and the first report on it.
    expect(hiddenQuestions([{ count: 2, seen: null }])).toBe(0);
  });
});

describe("where there is nothing to observe with", () => {
  // The tests run in node: no `IntersectionObserver`, as in a server render.
  it("registers and forgets a block without saying anything is hidden", () => {
    let told = 0;
    const stop = subscribeSight(() => { told += 1; });
    const forget = watchBlock("b1", {} as HTMLElement, 2);
    expect(hiddenNow()).toBe(0);
    expect(revealWaiting()).toBe(false);
    forget();
    expect(hiddenNow()).toBe(0);
    expect(told).toBe(0);
    stop();
  });
});

describe("run decisions in the same awareness row", () => {
  it("counts a host key once and uses a generic label only while decisions are hidden", () => {
    let report!: (entries: { target: HTMLElement; isIntersecting: boolean }[]) => void;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: typeof report) { report = callback; }
      observe() {} unobserve() {}
    });
    const question = {} as HTMLElement, decision = {} as HTMLElement;
    const stopQuestion = watchBlock("question:q", question, 1);
    const stopDecision = watchBlock("gate:host-id", decision, 1, "decision");
    const stopDuplicate = watchBlock("gate:host-id", decision, 1, "decision");
    try {
      report([{ target: question, isIntersecting: false }, { target: decision, isIntersecting: false }]);
      expect(hiddenNow()).toBe(2);
      expect(hasHiddenDecisions()).toBe(true);
      report([{ target: decision, isIntersecting: true }]);
      expect(hiddenNow()).toBe(1);
      expect(hasHiddenDecisions()).toBe(false);
    } finally { stopDuplicate(); stopDecision(); stopQuestion(); vi.unstubAllGlobals(); }
    expect(hiddenNow()).toBe(0);
  });
});
