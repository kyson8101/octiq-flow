import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelZenTransition, transitionZen } from "./zenMotion";

function pending() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("Zen motion preserves the user's latest action", () => {
  let dataset: Record<string, string>;
  let frames: { update: () => void; finish: ReturnType<typeof pending>; skip: ReturnType<typeof vi.fn> }[];
  let start: ReturnType<typeof vi.fn>;
  let animate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dataset = {};
    frames = [];
    animate = vi.fn();
    start = vi.fn((update: () => void) => {
      const frame = { update, finish: pending(), skip: vi.fn() };
      frames.push(frame);
      return { ready: Promise.resolve(), finished: frame.finish.promise, skipTransition: frame.skip };
    });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("document", {
      documentElement: { dataset },
      startViewTransition: start,
      querySelector: () => ({ animate }),
    });
  });

  afterEach(() => {
    cancelZenTransition();
    vi.unstubAllGlobals();
  });

  it("commits between snapshots, and clears its styling after completion", async () => {
    const update = vi.fn();
    transitionZen("enter", update);
    expect(update).not.toHaveBeenCalled();
    expect(dataset.zenTransition).toBe("enter");
    frames[0].update();
    expect(update).toHaveBeenCalledOnce();
    frames[0].finish.resolve();
    await frames[0].finish.promise;
    expect(dataset.zenTransition).toBeUndefined();
  });

  it("honors a quick exit even when the entry snapshot is still pending", async () => {
    const enter = vi.fn();
    const exit = vi.fn();
    transitionZen("enter", enter);
    transitionZen("exit", exit);
    expect(frames[0].skip).toHaveBeenCalledOnce();
    frames[0].update();
    frames[1].update();
    expect(enter).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
    frames[0].finish.resolve();
    await frames[0].finish.promise;
    expect(dataset.zenTransition).toBe("exit");
    frames[1].finish.resolve();
    await frames[1].finish.promise;
    expect(dataset.zenTransition).toBeUndefined();
  });

  it("cancels pending updates when leaving the chat workspace", () => {
    const update = vi.fn();
    transitionZen("enter", update);
    cancelZenTransition();
    frames[0].update();
    expect(update).not.toHaveBeenCalled();
    expect(dataset.zenTransition).toBeUndefined();
  });

  it("makes reduced-motion changes immediate, without snapshots or fallback fades", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const update = vi.fn();
    transitionZen("enter", update);
    expect(update).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(animate).not.toHaveBeenCalled();
  });

  it("keeps the mode usable in browsers without View Transitions", () => {
    Object.assign(document, { startViewTransition: undefined });
    const update = vi.fn();
    transitionZen("options", update);
    expect(update).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledOnce();
    expect(dataset.zenTransition).toBeUndefined();
  });

  it("still applies the action if starting a snapshot fails", () => {
    start.mockImplementation(() => { throw new Error("snapshot unavailable"); });
    const update = vi.fn();
    transitionZen("enter", update);
    expect(update).toHaveBeenCalledOnce();
    expect(dataset.zenTransition).toBeUndefined();
  });

  it("handles skipped snapshots without replaying an already applied toggle", async () => {
    start.mockImplementation((update: () => void) => {
      update();
      return { ready: Promise.reject(new Error("skipped")), finished: Promise.reject(new Error("interrupted")), skipTransition: vi.fn() };
    });
    const update = vi.fn();
    transitionZen("options", update);
    await Promise.resolve();
    expect(update).toHaveBeenCalledOnce();
    expect(dataset.zenTransition).toBeUndefined();
  });
});
