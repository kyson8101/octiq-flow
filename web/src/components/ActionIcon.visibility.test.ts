import { describe, expect, it } from "vitest";
import { lf } from "../lib/sourceText";
import teamCssRaw from "./AgentsSettings.css?raw";

describe("icon-only team actions", () => {
  it("does not hide the only glyph on desktop", () => {
    const css = lf(teamCssRaw).replace(/\/\*[^]*?\*\//g, "");
    for (const [, selector, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selector.includes(".team-row-action") || selector.includes(".team-row-action-text")) continue;
      expect(declarations).not.toMatch(/display:\s*none|visibility:\s*hidden|(?:^|;)\s*(?:width|height|opacity):\s*0\s*[;}]/);
    }
  });
});
