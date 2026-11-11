import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionIcon } from "./ActionIcon";

it("draws the short label after the glyph while the button owns the full name", () => {
  const html = renderToStaticMarkup(<button aria-label="Refresh delivery status" title="Refresh delivery status"><ActionIcon name="refresh" label="Refresh" /></button>);
  expect(html).toContain('</svg><span class="action-label" aria-hidden="true">Refresh</span>');
  expect(html).toContain('aria-label="Refresh delivery status" title="Refresh delivery status"');
});

describe("icon-only exceptions", () => {
  it.each(["copy", "dismiss", "edit", "delete", "expand", "collapse"] as const)("keeps %s without a label unless requested", name => {
    expect(renderToStaticMarkup(<ActionIcon name={name} />)).not.toContain("action-label");
  });
});
