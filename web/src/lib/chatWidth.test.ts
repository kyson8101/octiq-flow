import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_WIDTH_DEFAULT, CHAT_WIDTH_KEY, CHAT_WIDTHS, chatColumnValue, chatWidthStyle,
  parseChatWidth, savedChatWidth, saveChatWidth,
} from "./chatWidth";

describe("chat column width", () => {
  it("keeps the column the chat always had as the default", () => {
    expect(CHAT_WIDTH_DEFAULT).toBe("default");
    expect(chatColumnValue("default")).toBe("780px");
  });

  it("offers the widths narrowest first, ending with no cap", () => {
    const capped = CHAT_WIDTHS.filter((width) => width.px != null).map((width) => width.px as number);
    expect([...capped].sort((a, b) => a - b)).toEqual(capped);
    expect(CHAT_WIDTHS[CHAT_WIDTHS.length - 1]).toMatchObject({ id: "full", px: null });
    expect(chatColumnValue("narrow")).toBe("640px");
    expect(chatColumnValue("full")).toBe("none");
  });

  it("reads anything stored as one of the widths", () => {
    expect(parseChatWidth("wide")).toBe("wide");
    expect(parseChatWidth("full")).toBe("full");
    for (const raw of [null, undefined, "", "huge", "960", "WIDE"]) {
      expect(parseChatWidth(raw)).toBe(CHAT_WIDTH_DEFAULT);
    }
  });

  it("sets the column inline only when it differs and nothing else owns it", () => {
    expect(chatWidthStyle("default", false)).toBeUndefined();
    expect(chatWidthStyle("wide", false)).toEqual({ "--chat-column": "960px" });
    expect(chatWidthStyle("full", false)).toEqual({ "--chat-column": "none" });
    // Focus mode and the full-width view set their own column in CSS.
    expect(chatWidthStyle("wide", true)).toBeUndefined();
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

    it("round-trips a chosen width", () => {
      expect(savedChatWidth()).toBe(CHAT_WIDTH_DEFAULT);
      expect(saveChatWidth("wider")).toBe(true);
      expect(storage.get(CHAT_WIDTH_KEY)).toBe("wider");
      expect(savedChatWidth()).toBe("wider");
    });

    it("answers false, never throws, when storage refuses it", () => {
      vi.stubGlobal("localStorage", {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("quota"); },
      });
      expect(saveChatWidth("wide")).toBe(false);
      expect(savedChatWidth()).toBe(CHAT_WIDTH_DEFAULT);
    });
  });
});
