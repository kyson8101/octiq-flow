import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindDrawerSwipe } from "./swipe";

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
