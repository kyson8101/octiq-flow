// The top bar against the phone's status bar, read off the shipped files.
//
// Installed to an iPhone home screen on iOS 26+, the top ~36pt of a web app
// that reaches under the clock is covered by a Liquid Glass blur no page can
// switch off, and on iOS 27 that smeared the whole top bar. Three things keep
// it readable, and each one is a line someone could tidy away without seeing
// anything change in a desktop browser — which is why they are pinned here.
import { describe, expect, it } from "vitest";

import css from "../styles.css?raw";
import html from "../../index.html?raw";

/** Every declaration block whose selector list is exactly `.topbar`. */
function topbarBlocks(source: string): string[] {
  const blocks: string[] = [];
  const rule = /(^|[\s}])\.topbar\s*\{([^}]*)\}/g;
  for (let match = rule.exec(source); match; match = rule.exec(source)) blocks.push(match[2]);
  return blocks;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the top bar and the status bar", () => {
  it("asks for an opaque status bar, so the page starts below the clock", () => {
    // `black-translucent` put the page under the clock, where iOS 27 blurs it
    // whatever the page does. With `default` WebKit fills the band with the
    // colour of the top bar instead.
    const tag = html.match(/<meta\s+name="apple-mobile-web-app-status-bar-style"\s+content="([^"]+)"/);
    expect(tag?.[1]).toBe("default");
  });

  it("is sticky at the top, the box WebKit takes the status bar's colour from", () => {
    const [base] = topbarBlocks(withoutComments(css));
    expect(base).toMatch(/position:\s*sticky/);
    expect(base).toMatch(/top:\s*0/);
  });

  it("keeps the status-bar inset as its top padding on every screen size", () => {
    // The phone rule once used the `padding` shorthand for its side gutters,
    // which also zeroed the top: the bar kept its `48px + inset` height, so the
    // row was centred across the clock and the blur, not below them.
    const [base, ...overrides] = topbarBlocks(withoutComments(css));
    expect(base).toMatch(/height:\s*calc\(48px \+ env\(safe-area-inset-top\)\)/);
    expect(base).toMatch(/padding:\s*env\(safe-area-inset-top\)/);
    expect(overrides.length).toBeGreaterThan(0);
    for (const block of overrides) {
      expect(block).not.toMatch(/(^|[\s;])padding\s*:/);
      expect(block).not.toMatch(/padding-top\s*:/);
    }
  });
});
