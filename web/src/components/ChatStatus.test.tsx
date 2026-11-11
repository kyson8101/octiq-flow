import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusDismiss } from "./ChatStatus";

describe("the shared Dismiss control", () => {
  it("keeps the full action as its accessible name and tooltip, with only the shared × inside", () => {
    const html = renderToStaticMarkup(<StatusDismiss label="Dismiss without answering" visible onClick={() => {}} />);
    expect(html).toContain('aria-label="Dismiss without answering" title="Dismiss without answering"');
    expect(html).toContain('d="M6 6l12 12M18 6 6 18"');
    expect(html).not.toContain(">Dismiss");
  });
  it("dims a disabled pending dismissal without bringing its text label back", () => {
    const html = renderToStaticMarkup(<StatusDismiss label="Dismiss" disabled visible onClick={() => {}} />);
    expect(html).toContain('disabled="" aria-disabled="true"');
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).not.toContain("Dismissing");
  });
});
