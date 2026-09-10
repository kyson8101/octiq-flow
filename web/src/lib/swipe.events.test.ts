import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bindDrawerSwipe, useDrawerSwipe } from "./swipe";

class Shell extends EventTarget {
  attributes = new Map<string, string>();
  properties = new Map<string, string>();
  clientWidth = 300;
  className = "app";
  style = {
    setProperty: (key: string, value: string) => this.properties.set(key, value),
    removeProperty: (key: string) => this.properties.delete(key),
  };
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  querySelector() { return { offsetWidth: 300 }; }
}

function touch(shell: Shell, type: string, x: number, t: number, count = 1, cancelable = true) {
  const event = new Event(type, { cancelable });
  Object.defineProperties(event, {
    touches: { value: Array.from({ length: count }, () => ({ clientX: x, clientY: 300 })) },
    timeStamp: { value: t },
  });
  shell.dispatchEvent(event);
  return event;
}
function click(shell: Shell, detail = 1) {
  const event = new Event("click", { cancelable: true });
  Object.defineProperty(event, "detail", { value: detail });
  shell.dispatchEvent(event);
  return event;
}

describe("drawer touch lifecycle", () => {
  let shell: Shell;
  let changed: ReturnType<typeof vi.fn<(open: boolean) => void>>;
  let dispose: () => void;
  beforeEach(() => {
    vi.stubGlobal("window", { getSelection: () => null });
    vi.stubGlobal("Element", class {});
    shell = new Shell();
    changed = vi.fn<(open: boolean) => void>();
    dispose = bindDrawerSwipe(shell as unknown as HTMLElement, () => false, changed);
  });
  afterEach(() => { dispose(); vi.unstubAllGlobals(); });

  const drag = () => {
    touch(shell, "touchstart", 5, 0);
    touch(shell, "touchmove", 180, 100);
  };
  const expectCleared = () => {
    expect(shell.attributes.has("data-drawer-swiping")).toBe(false);
    expect(shell.properties.has("--swipe-p")).toBe(false);
  };

  it("opens on release and blocks the following click before a chat or scrim handles it", () => {
    const pickChat = vi.fn();
    shell.addEventListener("click", pickChat);
    drag();
    expect(touch(shell, "touchend", 180, 110, 0).defaultPrevented).toBe(true);
    expect(changed).toHaveBeenCalledExactlyOnceWith(true);
    expectCleared();
    expect(click(shell).defaultPrevented).toBe(true);
    expect(pickChat).not.toHaveBeenCalled();
  });

  it("binds on the first shell attachment, even when the shell appears after connection", () => {
    dispose();
    let attach!: ReturnType<typeof useDrawerSwipe>;
    function Harness() {
      attach = useDrawerSwipe({ enabled: true, open: false, onChange: changed });
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    attach(null);
    dispose = attach(shell as unknown as HTMLElement)!;
    drag();
    touch(shell, "touchend", 180, 110, 0);
    expect(changed).toHaveBeenCalledExactlyOnceWith(true);
    dispose();
    changed.mockClear();
    drag();
    touch(shell, "touchend", 180, 220, 0);
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not attach mobile navigation gestures on desktop", () => {
    dispose();
    let attach!: ReturnType<typeof useDrawerSwipe>;
    function Harness() {
      attach = useDrawerSwipe({ enabled: false, open: false, onChange: changed });
      return null;
    }
    renderToStaticMarkup(createElement(Harness));
    expect(attach(shell as unknown as HTMLElement)).toBeUndefined();
    drag();
    touch(shell, "touchend", 180, 110, 0);
    expect(changed).not.toHaveBeenCalled();
  });

  it("reserves the closed drawer's edge before browser history navigation can start", () => {
    const edge = touch(shell, "touchstart", 5, 0);
    expect(edge.defaultPrevented).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    touch(shell, "touchmove", 180, 100);
    touch(shell, "touchend", 180, 110, 0);
    expect(changed).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("registers a non-passive touchstart so the edge can cancel native navigation", () => {
    dispose();
    const listen = vi.spyOn(shell, "addEventListener");
    dispose = bindDrawerSwipe(shell as unknown as HTMLElement, () => false, changed);
    expect(listen).toHaveBeenCalledWith("touchstart", expect.any(Function), { passive: false });
    listen.mockRestore();
  });

  it("does not reserve ordinary touches outside the edge", () => {
    expect(touch(shell, "touchstart", 80, 0).defaultPrevented).toBe(false);
    dispose();
    dispose = bindDrawerSwipe(shell as unknown as HTMLElement, () => true, changed);
    expect(touch(shell, "touchstart", 80, 10).defaultPrevented).toBe(false);
    touch(shell, "touchend", 80, 20, 0);
    expect(click(shell).defaultPrevented).toBe(false);
  });

  it("also prevents native back navigation from the edge of an open drawer", () => {
    dispose();
    dispose = bindDrawerSwipe(shell as unknown as HTMLElement, () => true, changed);
    expect(touch(shell, "touchstart", 5, 0).defaultPrevented).toBe(true);
  });

  it("blocks clicks throughout the drag, before touchend arrives", () => {
    const pickChat = vi.fn();
    shell.addEventListener("click", pickChat);
    drag();
    expect(click(shell).defaultPrevented).toBe(true);
    expect(click(shell, 0).defaultPrevented).toBe(true);
    expect(pickChat).not.toHaveBeenCalled();
  });

  it("blocks zero-detail and repeated synthetic clicks after release", () => {
    drag();
    touch(shell, "touchend", 180, 110, 0);
    expect(click(shell, 0).defaultPrevented).toBe(true);
    expect(click(shell).defaultPrevented).toBe(true);
    expect(click(shell).defaultPrevented).toBe(true);
  });

  it("keeps click protection after the browser cancels a claimed swipe", () => {
    drag();
    touch(shell, "touchcancel", 180, 110, 0);
    expectCleared();
    expect(click(shell, 0).defaultPrevented).toBe(true);
    expect(changed).not.toHaveBeenCalled();
  });

  it("blocks a synthetic click even when touchend cannot be canceled", () => {
    drag();
    touch(shell, "touchend", 180, 110, 0, false);
    expect(changed).toHaveBeenCalledExactlyOnceWith(true);
    expect(click(shell).defaultPrevented).toBe(true);
  });

  it("closes without activating the chat under the closing gesture", () => {
    dispose();
    dispose = bindDrawerSwipe(shell as unknown as HTMLElement, () => true, changed);
    touch(shell, "touchstart", 280, 0);
    touch(shell, "touchmove", 60, 100);
    touch(shell, "touchend", 60, 110, 0);
    expect(changed).toHaveBeenCalledExactlyOnceWith(false);
    expect(click(shell).defaultPrevented).toBe(true);
    expectCleared();
  });

  it("preserves an immediate deliberate tap after a swipe", () => {
    drag();
    touch(shell, "touchend", 180, 110, 0);
    touch(shell, "touchstart", 180, 120);
    touch(shell, "touchend", 180, 130, 0);
    expect(click(shell).defaultPrevented).toBe(false);
  });

  it("does not block keyboard activation or ordinary taps", () => {
    expect(click(shell).defaultPrevented).toBe(false);
    drag();
    touch(shell, "touchend", 180, 110, 0);
    const key = new Event("keydown");
    Object.defineProperty(key, "key", { value: "Enter" });
    shell.dispatchEvent(key);
    expect(click(shell, 0).defaultPrevented).toBe(false);
  });

  it("clears the painted drawer when a second finger starts a pinch", () => {
    drag();
    touch(shell, "touchstart", 180, 110, 2);
    expectCleared();
    touch(shell, "touchend", 180, 150, 0);
    expect(changed).not.toHaveBeenCalled();
  });

  it("abandons a gesture when the browser has taken over scrolling", () => {
    drag();
    touch(shell, "touchmove", 190, 110, 1, false);
    expectCleared();
    touch(shell, "touchend", 190, 130, 0);
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps drag styling when React updates the shell className", () => {
    drag();
    shell.className = "app nav-shut";
    expect(shell.attributes.has("data-drawer-swiping")).toBe(true);
    expect(Number(shell.properties.get("--swipe-p"))).toBeGreaterThan(0);
    touch(shell, "touchcancel", 180, 110, 0);
    expectCleared();
    expect(changed).not.toHaveBeenCalled();
  });

  it("removes gesture styling and listeners on cleanup", () => {
    drag();
    dispose();
    expectCleared();
    touch(shell, "touchend", 180, 110, 0);
    expect(changed).not.toHaveBeenCalled();
  });
});
