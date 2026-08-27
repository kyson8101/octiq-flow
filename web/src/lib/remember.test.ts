// A setting is written down when there is room, and the caller carries on
// either way.
//
// The bug this covers was not "the setting was forgotten" — it was that
// forgetting it THREW, and the throw came before the line that told the agent.
// So the test that matters is the one about what happens next.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forget, recall, remember } from "./remember";

/** A store at its quota: reads work, writes throw, exactly as a browser does. */
function fullStore() {
  const held = new Map<string, string>([["kept", "yes"]]);
  return {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: () => {
      throw new DOMException("quota", "QuotaExceededError");
    },
    removeItem: () => {
      throw new DOMException("quota", "QuotaExceededError");
    },
  };
}

const real = globalThis.localStorage;

beforeEach(() => {
  const held = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
    removeItem: (k: string) => void held.delete(k),
  });
});

afterEach(() => {
  vi.stubGlobal("localStorage", real);
});

describe("remembering a setting", () => {
  it("writes it, and says so", () => {
    expect(remember("octiq.v2.effort", "ultracode")).toBe(true);
    expect(recall("octiq.v2.effort")).toBe("ultracode");
  });

  it("says no rather than throwing when the store is full", () => {
    vi.stubGlobal("localStorage", fullStore());

    expect(() => remember("octiq.v2.effort", "ultracode")).not.toThrow();
    expect(remember("octiq.v2.effort", "ultracode")).toBe(false);
  });

  it("lets the caller get to the line after it", () => {
    // The whole point. `changeEffort` writes the level down and THEN tells the
    // agent; when the write threw, the agent was never told — not once, in any
    // transcript on the machine this was found on.
    vi.stubGlobal("localStorage", fullStore());
    const told: string[] = [];

    const changeEffort = (level: string) => {
      remember("octiq.v2.effort", level);
      told.push(`/effort ${level}`);
    };
    changeEffort("ultracode");

    expect(told).toEqual(["/effort ultracode"]);
  });

  it("reads back nothing, rather than throwing, from a store it cannot read", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
      removeItem: () => {},
    });

    expect(recall("octiq.v2.effort")).toBeNull();
  });

  it("forgets quietly", () => {
    remember("octiq.v2.effort", "max");
    forget("octiq.v2.effort");
    expect(recall("octiq.v2.effort")).toBeNull();

    vi.stubGlobal("localStorage", fullStore());
    expect(() => forget("octiq.v2.effort")).not.toThrow();
  });
});
