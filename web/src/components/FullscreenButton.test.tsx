// The button draws itself only where it would work, and says which way it goes.
//
// The case that matters most is the one with no output at all: on a browser
// with no fullscreen — iOS Safari in a tab, an iframe without
// `allow-fullscreen` — this has to render nothing, because a control that is
// present and does nothing is worse than one that was never offered.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FullscreenButton } from "./FullscreenButton";

/** A document that can do it, either already fullscreen or not. Only the
 *  fields `lib/fullscreen` reads are here — see FsDoc there. */
function browser(full = false) {
  return {
    fullscreenElement: full ? {} : null,
    fullscreenEnabled: true,
    exitFullscreen: () => Promise.resolve(),
    documentElement: { requestFullscreen: () => Promise.resolve() },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the full-screen switch", () => {
  it("offers to go in, and reads as up, from a normal window", () => {
    vi.stubGlobal("document", browser());
    const out = renderToStaticMarkup(<FullscreenButton />);
    expect(out).toContain("Full screen");
    expect(out).toContain('aria-pressed="false"');
    expect(out).not.toContain("is-on");
  });

  it("offers to come out, and reads as held down, from inside it", () => {
    vi.stubGlobal("document", browser(true));
    const out = renderToStaticMarkup(<FullscreenButton />);
    expect(out).toContain("Leave full screen");
    expect(out).toContain('aria-pressed="true"');
    // Held down is a state you can see, not only one the button knows.
    expect(out).toContain("is-on");
  });

  it("says Escape is the other way out, since the browser honours it either way", () => {
    vi.stubGlobal("document", browser(true));
    expect(renderToStaticMarkup(<FullscreenButton />)).toContain("Esc");
  });

  it("draws nothing at all where the browser cannot do it", () => {
    // iOS Safari in a tab: no fullscreen outside a video.
    vi.stubGlobal("document", { fullscreenEnabled: false, documentElement: {} });
    expect(renderToStaticMarkup(<FullscreenButton />)).toBe("");
  });

  it("draws nothing when the method is there but the browser has turned it off", () => {
    vi.stubGlobal("document", {
      fullscreenEnabled: false,
      documentElement: { requestFullscreen: () => Promise.resolve() },
    });
    expect(renderToStaticMarkup(<FullscreenButton />)).toBe("");
  });

  it("keeps both arrow sets in the icon, so the swap can cross-fade", () => {
    vi.stubGlobal("document", browser());
    const out = renderToStaticMarkup(<FullscreenButton />);
    expect(out).toContain("fs-arrows-in");
    expect(out).toContain("fs-arrows-out");
  });
});
