import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FocusFontSizeControl, focusFontStyle } from "./FocusMode";

describe("FocusFontSizeControl", () => {
  it("offers both directions in the middle of the range and names the size", () => {
    const html = renderToStaticMarkup(<FocusFontSizeControl fontSize={16} onChange={() => {}} />);
    expect(html).toContain('role="group" aria-label="Text size, 16 pixels"');
    expect(html).toMatch(/aria-label="Smaller text" title="Smaller text \(now 16px\)" aria-disabled="false"/);
    expect(html).toMatch(/aria-label="Larger text" title="Larger text \(now 16px\)" aria-disabled="false"/);
    expect(html).not.toContain("disabled=\"\"");
  });

  it("marks an end of the range without taking the button out of the tab order", () => {
    const largest = renderToStaticMarkup(<FocusFontSizeControl fontSize={24} onChange={() => {}} />);
    expect(largest).toMatch(/aria-label="Larger text" title="Largest text \(24px\)" aria-disabled="true"/);
    expect(largest).toMatch(/aria-label="Smaller text"[^>]+aria-disabled="false"/);
    const smallest = renderToStaticMarkup(<FocusFontSizeControl fontSize={14} onChange={() => {}} />);
    expect(smallest).toMatch(/aria-label="Smaller text" title="Smallest text \(14px\)" aria-disabled="true"/);
    for (const html of [largest, smallest]) expect(html).not.toContain("disabled=\"\"");
  });

  it("hands the size to the column as a CSS variable", () => {
    expect(focusFontStyle(20)).toEqual({ "--focus-font-size": "20px" });
  });
});
