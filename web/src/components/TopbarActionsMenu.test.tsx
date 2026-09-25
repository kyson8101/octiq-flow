import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TopbarActionLayout, TopbarActionsMenu } from "./TopbarActionsMenu";

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

  it("keeps primary instruments direct and every secondary action in one overflow", () => {
    const html = renderToStaticMarkup(
      <TopbarActionLayout
        initiallyOpen
        directActions={<><button>Preview</button><button>Git</button><button>Focus</button></>}
        overflowActions={<><button>Files</button><button>Pull requests</button><span role="separator" /><button>Delete conversation</button></>}
      />,
    );
    expect(html.match(/class="mobile-actions"/g)).toHaveLength(1);
    expect(html.indexOf("Preview")).toBeLessThan(html.indexOf('class="mobile-actions"'));
    expect(html.indexOf("Git")).toBeLessThan(html.indexOf('class="mobile-actions"'));
    expect(html.indexOf("Focus")).toBeLessThan(html.indexOf('class="mobile-actions"'));
    const menu = html.slice(html.indexOf('class="mobile-actions-panel"'));
    expect(menu).toContain("Files");
    expect(menu).toContain("Pull requests");
    expect(menu.indexOf('role="separator"')).toBeLessThan(menu.indexOf("Delete conversation"));
    expect(menu.endsWith("</div></div>")).toBe(true);
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
