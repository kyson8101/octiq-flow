// The control exists only where the browser offers none of its own, so the
// interesting cases are both of the answers to "is this installed?" — and the
// fact that a plain tab gets NOTHING rather than a second reload button.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InstalledReload } from "./InstalledReload";

describe("the installed-window reload", () => {
  it("draws nothing in a browser tab, which has its own reload", () => {
    expect(renderToStaticMarkup(<InstalledReload show={false} />)).toBe("");
  });

  it("draws a labelled reload once there is no chrome to reload from", () => {
    const out = renderToStaticMarkup(<InstalledReload show />);
    expect(out).toContain('aria-label="Reload"');
    expect(out).toContain("installed-reload");
    // Not spinning until it is pressed.
    expect(out).not.toContain("is-spinning");
  });

  it("asks the real question when nothing is passed, and stays away in a test env", () => {
    // `matchMedia` is absent here, which is exactly the SSR/test case the
    // component swallows rather than throwing on.
    expect(() => renderToStaticMarkup(<InstalledReload />)).not.toThrow();
    expect(renderToStaticMarkup(<InstalledReload />)).toBe("");
  });

  it("reloads rather than navigating, since the app keeps one history entry", () => {
    // A back button would have nowhere to go: App.tsx's syncHash uses
    // replaceState on purpose. Guard that this control never grew one.
    const onReload = vi.fn();
    const out = renderToStaticMarkup(<InstalledReload show onReload={onReload} />);
    expect(out).not.toContain("Back");
  });
});
