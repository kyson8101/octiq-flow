// Filling the screen, across three browsers that spell it differently and one
// that cannot do it at all.
//
// The cases worth holding down are the ones a real browser produced and a
// hand-rolled implementation gets wrong: Safari's `webkit` methods return
// undefined rather than a promise, Chrome rejects a request that did not come
// from a gesture, and iOS keeps neither method — all three of which have to end
// as a `false` and not as a throw somewhere up the call stack.
import { describe, expect, it, vi } from "vitest";
import {
  canFullscreen,
  enter,
  exit,
  isFullscreen,
  toggle,
  type FsDoc,
  type FsElement,
} from "./fullscreen";

/** A standards browser: promise-returning methods, both names unprefixed. */
function chrome(startsFull = false) {
  const el = {} as Element;
  const doc: FsDoc = {
    fullscreenElement: startsFull ? el : null,
    fullscreenEnabled: true,
    exitFullscreen: vi.fn(async () => {
      doc.fullscreenElement = null;
    }),
  };
  const root: FsElement = {
    requestFullscreen: vi.fn(async () => {
      doc.fullscreenElement = el;
    }),
  };
  return { doc, root };
}

/** Safari: only the `webkit` spellings, and `webkitRequestFullscreen` hands
 *  back nothing at all rather than a promise. */
function safari() {
  const el = {} as Element;
  const doc: FsDoc = {
    webkitFullscreenElement: null,
    webkitFullscreenEnabled: true,
    webkitExitFullscreen: vi.fn(() => {
      doc.webkitFullscreenElement = null;
    }),
  };
  const root: FsElement = {
    webkitRequestFullscreen: vi.fn(() => {
      doc.webkitFullscreenElement = el;
    }),
  };
  return { doc, root };
}

/** iOS Safari in a tab: no fullscreen for anything that is not a video. */
function iphone() {
  return { doc: { fullscreenEnabled: false } as FsDoc, root: {} as FsElement };
}

describe("reading the current state", () => {
  it("is false with nothing up", () => {
    const { doc } = chrome();
    expect(isFullscreen(doc)).toBe(false);
  });

  it("is true for either spelling", () => {
    expect(isFullscreen(chrome(true).doc)).toBe(true);
    expect(isFullscreen({ webkitFullscreenElement: {} as Element })).toBe(true);
  });

  it("is false, not a throw, with no document at all", () => {
    expect(isFullscreen(null)).toBe(false);
  });
});

describe("whether to offer it", () => {
  it("says yes when the browser has both halves", () => {
    const { doc, root } = chrome();
    expect(canFullscreen(doc, root)).toBe(true);
  });

  it("says yes to Safari's prefixed half", () => {
    const { doc, root } = safari();
    expect(canFullscreen(doc, root)).toBe(true);
  });

  it("says no on a phone that cannot, so no button is drawn", () => {
    const { doc, root } = iphone();
    expect(canFullscreen(doc, root)).toBe(false);
  });

  it("says no when the method is there but the browser has turned it off", () => {
    // Chrome in an iframe without `allow-fullscreen`: it keeps
    // `requestFullscreen` and refuses every call to it.
    const { root } = chrome();
    expect(canFullscreen({ fullscreenEnabled: false }, root)).toBe(false);
  });
});

describe("going in and coming out", () => {
  it("asks the element, and says it went through", async () => {
    const { doc, root } = chrome();
    await expect(enter(root)).resolves.toBe(true);
    expect(root.requestFullscreen).toHaveBeenCalled();
    expect(isFullscreen(doc)).toBe(true);
  });

  it("copes with Safari handing back undefined instead of a promise", async () => {
    const { doc, root } = safari();
    await expect(enter(root)).resolves.toBe(true);
    expect(isFullscreen(doc)).toBe(true);
    await expect(exit(doc)).resolves.toBe(true);
    expect(isFullscreen(doc)).toBe(false);
  });

  it("answers a refused request with false rather than throwing", async () => {
    // What Chrome does when the call did not come from a real gesture.
    const root: FsElement = {
      requestFullscreen: vi.fn(async () => {
        throw new TypeError("not a user gesture");
      }),
    };
    await expect(enter(root)).resolves.toBe(false);
  });

  it("answers a browser with no method at all with false", async () => {
    await expect(enter({})).resolves.toBe(false);
    await expect(exit({})).resolves.toBe(false);
    await expect(enter(null)).resolves.toBe(false);
    await expect(exit(null)).resolves.toBe(false);
  });

  it("calls the method ON the element, not detached from it", async () => {
    // Pulled off the element and called bare, Chrome throws "Illegal
    // invocation" instead of rejecting — which `attempt` would swallow into a
    // silent false. So the receiver is what this checks.
    let receiver: unknown = null;
    const root = {
      requestFullscreen: function (this: unknown) {
        receiver = this;
        return Promise.resolve();
      },
    } as FsElement;
    await enter(root);
    expect(receiver).toBe(root);

    let docReceiver: unknown = null;
    const doc = {
      exitFullscreen: function (this: unknown) {
        docReceiver = this;
        return Promise.resolve();
      },
    } as FsDoc;
    await exit(doc);
    expect(docReceiver).toBe(doc);
  });
});

describe("the toggle a button presses", () => {
  it("goes in from normal", async () => {
    const { doc, root } = chrome();
    await toggle(doc, root);
    expect(root.requestFullscreen).toHaveBeenCalled();
    expect(doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it("comes out from full", async () => {
    const { doc, root } = chrome(true);
    await toggle(doc, root);
    expect(doc.exitFullscreen).toHaveBeenCalled();
    expect(root.requestFullscreen).not.toHaveBeenCalled();
  });

  it("comes out of a fullscreen this app never asked for", async () => {
    // Escape and F11 do not go through this module, and neither does a picture
    // the viewer put up on its own. The state is read off the document every
    // time precisely so the next press still does the right thing.
    const { doc, root } = chrome();
    doc.fullscreenElement = {} as Element;
    await toggle(doc, root);
    expect(doc.exitFullscreen).toHaveBeenCalled();
  });
});
