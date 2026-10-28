import { describe, expect, it, vi } from "vitest";
import { hideFileActionPopover, showFileActionPopover } from "./fileActionPopover";

function menu(showPopover?: () => void, hidePopover?: () => void) {
  const attributes = new Map<string, string>();
  const popup = {
    showPopover, hidePopover,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    removeAttribute: (key: string) => attributes.delete(key),
  } as unknown as HTMLElement;
  return { popup, attributes };
}

describe("optional file-action top layer", () => {
  it("keeps the in-flow menu when either native method is missing", () => {
    for (const methods of [[undefined, undefined], [vi.fn(), undefined], [undefined, vi.fn()]] as const) {
      const { popup, attributes } = menu(...methods);
      expect(showFileActionPopover(popup)).toBe(false);
      expect(attributes.has("popover")).toBe(false);
      expect(() => hideFileActionPopover(popup)).not.toThrow();
      if (methods[0]) expect(methods[0]).not.toHaveBeenCalled();
    }
  });

  it("removes the popover attribute when showing fails, even if hiding fails too", () => {
    const invalidState = () => { throw new DOMException("Not available", "InvalidStateError"); };
    for (const hide of [vi.fn(), invalidState]) {
      const { popup, attributes } = menu(invalidState, hide);
      expect(showFileActionPopover(popup)).toBe(false);
      expect(attributes.has("popover")).toBe(false);
    }
  });

  it("always releases the top layer on close, including a throwing or removed hide method", () => {
    for (const hide of [vi.fn(), () => { throw new Error("closed"); }, undefined]) {
      const { popup, attributes } = menu(vi.fn(), vi.fn());
      expect(showFileActionPopover(popup)).toBe(true);
      expect(attributes.get("popover")).toBe("manual");
      popup.hidePopover = hide as HTMLElement["hidePopover"];
      expect(() => hideFileActionPopover(popup)).not.toThrow();
      expect(attributes.has("popover")).toBe(false);
    }
  });
});
