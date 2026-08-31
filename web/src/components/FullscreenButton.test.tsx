// The control changes the app's layout; it never asks the browser to enter
// fullscreen. Its label and held state are the whole accessible contract.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FullscreenButton } from "./FullscreenButton";

describe("the full-width chat switch", () => {
  it("offers to expand the chat without depending on browser fullscreen", () => {
    const out = renderToStaticMarkup(
      <FullscreenButton expanded={false} onToggle={() => {}} />,
    );
    expect(out).toContain("Expand chat to full width");
    expect(out).toContain('aria-pressed="false"');
    expect(out).not.toContain("is-on");
  });

  it("offers to restore the normal width while it is expanded", () => {
    const out = renderToStaticMarkup(<FullscreenButton expanded onToggle={() => {}} />);
    expect(out).toContain("Restore standard chat width");
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("is-on");
  });

  it("keeps both arrow sets in the icon, so the swap can cross-fade", () => {
    const out = renderToStaticMarkup(
      <FullscreenButton expanded={false} onToggle={() => {}} />,
    );
    expect(out).toContain("chat-width-arrows-in");
    expect(out).toContain("chat-width-arrows-out");
  });
});
