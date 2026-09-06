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
});
