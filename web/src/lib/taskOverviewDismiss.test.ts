import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dismissTaskOverview, dismissedTaskOverviewTurn } from "./taskOverviewDismiss";

const real = globalThis.localStorage;

describe("task overview dismissal", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  });

  afterEach(() => vi.stubGlobal("localStorage", real));

  it("remembers only the dismissed turn in each conversation", () => {
    dismissTaskOverview("chat-1", "turn-1");
    expect(dismissedTaskOverviewTurn("chat-1")).toBe("turn-1");
    expect(dismissedTaskOverviewTurn("chat-2")).toBeUndefined();

    dismissTaskOverview("chat-1", "turn-2");
    expect(dismissedTaskOverviewTurn("chat-1")).toBe("turn-2");
  });

  it("fails open when the stored preference is damaged", () => {
    localStorage.setItem("octiq.v2.dismissedTaskOverviews", "not json");
    expect(dismissedTaskOverviewTurn("chat-1")).toBeUndefined();
  });
});
