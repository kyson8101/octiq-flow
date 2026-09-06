import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TopbarActionsMenu } from "./TopbarActionsMenu";

describe("the phone top-bar action menu", () => {
  it("keeps the actions behind one labelled disclosure", () => {
    const closed = renderToStaticMarkup(
      <TopbarActionsMenu><button type="button">Settings</button></TopbarActionsMenu>,
    );
    expect(closed).toContain('aria-label="Chat actions"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("Settings");

    const open = renderToStaticMarkup(
      <TopbarActionsMenu initiallyOpen><button type="button">Settings</button></TopbarActionsMenu>,
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('role="group"');
    expect(open).toContain("Settings");
  });

  it("keeps actionable attention visible while the menu is closed", () => {
    const html = renderToStaticMarkup(
      <TopbarActionsMenu attentionCount={2}><button type="button">Settings</button></TopbarActionsMenu>,
    );
    expect(html).toContain('aria-label="Chat actions, 2 items need attention"');
    expect(html).toContain('class="mobile-actions-attention"');
    expect(html).toContain(">2</span>");
  });
});
