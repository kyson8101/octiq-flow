import { describe, expect, it } from "vitest";
import { lf } from "../lib/sourceText";

const styles = import.meta.glob("../**/*.css", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// These are the shared label and its containing action buttons. Scan inherited
// hiding too: a visible span still disappears inside a hidden/zero-size button.
const actionSelector = /\.action-(?:icon|label)\b|\[data-icon-action\]|\.(?:ask-btn|orch-delivery-(?:go|keep|opener|action)|task-start|qa-submit|handover-(?:go|quiet)|team-row-action)\b/;
const hidden = /(?:^|;)\s*(?:display:\s*none|visibility:\s*hidden|(?:width|height|max-width|max-height|font-size|opacity):\s*0(?:px)?\s*(?:!important)?\s*(?:;|$))/;

describe("action glyph and visible-label CSS", () => {
  it("never hides a label or glyph with an older component rule", () => {
    for (const [path, source] of Object.entries(styles)) {
      const css = lf(source).replace(/\/\*[^]*?\*\//g, "");
      for (const [, selectors, declarations] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        for (const selector of selectors.split(",")) {
          // These are intentional hidden states, and the old row-only text is
          // not a shared label (team pencil/trash deliberately stay icon-only).
          if (selector.includes("[hidden]") || selector.includes(".team-row-action-text")) continue;
          if (!actionSelector.test(selector)) continue;
          expect(declarations, `${path}: ${selector.trim()}`).not.toMatch(hidden);
        }
      }
    }
  });
});
