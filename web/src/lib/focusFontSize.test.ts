import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canStepFocusFontSize, FOCUS_FONT_DEFAULT, FOCUS_FONT_KEY, FOCUS_FONT_SIZES,
  parseFocusFontSize, savedFocusFontSize, saveFocusFontSize, stepFocusFontSize,
} from "./focusFontSize";

describe("focus mode text size", () => {
  it("keeps the size focus mode always had as the default", () => {
    expect(FOCUS_FONT_DEFAULT).toBe(16);
    expect(FOCUS_FONT_SIZES).toContain(FOCUS_FONT_DEFAULT);
    expect([...FOCUS_FONT_SIZES].sort((a, b) => a - b)).toEqual(FOCUS_FONT_SIZES);
  });

  it("reads anything stored as a size on the ladder", () => {
    expect(parseFocusFontSize("20")).toBe(20);
    expect(parseFocusFontSize("21.4")).toBe(22);
    expect(parseFocusFontSize("19")).toBe(18);
    expect(parseFocusFontSize("2")).toBe(14);
    expect(parseFocusFontSize("400")).toBe(24);
    for (const raw of [null, undefined, "", " ", "large", "NaN", "Infinity"]) {
      expect(parseFocusFontSize(raw)).toBe(FOCUS_FONT_DEFAULT);
    }
  });

  it("steps one rung at a time and stops at either end", () => {
    expect(stepFocusFontSize(16, 1)).toBe(17);
    expect(stepFocusFontSize(18, 1)).toBe(20);
    expect(stepFocusFontSize(16, -1)).toBe(15);
    expect(stepFocusFontSize(24, 1)).toBe(24);
    expect(stepFocusFontSize(14, -1)).toBe(14);
    expect(canStepFocusFontSize(24, 1)).toBe(false);
    expect(canStepFocusFontSize(24, -1)).toBe(true);
    expect(canStepFocusFontSize(14, -1)).toBe(false);
  });

  describe("remembering", () => {
    let storage: Map<string, string>;
    beforeEach(() => {
      storage = new Map();
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it("round-trips a chosen size", () => {
      expect(savedFocusFontSize()).toBe(FOCUS_FONT_DEFAULT);
      expect(saveFocusFontSize(20)).toBe(true);
      expect(storage.get(FOCUS_FONT_KEY)).toBe("20");
      expect(savedFocusFontSize()).toBe(20);
    });

    it("answers false, never throws, when storage refuses it", () => {
      vi.stubGlobal("localStorage", {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("quota"); },
      });
      expect(saveFocusFontSize(20)).toBe(false);
      expect(savedFocusFontSize()).toBe(FOCUS_FONT_DEFAULT);
    });
  });
});
