import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/push", () => ({
  disable: vi.fn(),
  enable: vi.fn(),
  isIOS: () => false,
  supported: () => false,
}));

import { Settings } from "./Settings";

describe("Settings", () => {
  it("opens as a categorized settings page with projects as the current section", () => {
    const out = renderToStaticMarkup(
      <Settings
        current="dark"
        onPick={() => {}}
        notify={false}
        onNotify={() => {}}
        projects={[
          { id: "p1", name: "octiq-flow", primary_path: "/work/octiq-flow" },
          { id: "p2", name: "archive", primary_path: "/work/archive", shelved: true },
        ]}
        onProject={() => {}}
        onClose={() => {}}
      />,
    );

    expect(out).toContain('class="panel settings-page"');
    expect(out).toContain('aria-label="Settings sections"');
    expect(out).toContain('aria-current="page"');
    expect(out).toContain("Projects</span>");
    expect(out).toContain("New project</span>");
    expect(out).toContain('aria-label="Configure octiq-flow"');
    expect(out).toContain('aria-label="Configure archive"');
    expect(out).toContain("Shelved</span>");
    expect(out).toContain("Appearance</span>");
    expect(out).toContain("<small>Dark</small>");
    // A section owns its content instead of mounting every setting in one scroller.
    expect(out).not.toContain("Candyland");
  });
});
