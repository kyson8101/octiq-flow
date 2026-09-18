import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceLoader } from "./WorkspaceLoader";

describe("WorkspaceLoader", () => {
  it("announces the loading state while keeping its workbench decorative", () => {
    const out = renderToStaticMarkup(<WorkspaceLoader />);

    expect(out).toContain('role="status"');
    expect(out).toContain('aria-label="Opening your workspace"');
    expect(out).toContain("Bringing your projects and conversations back into view.");
    expect(out).toContain('class="workspace-loader-workbench" aria-hidden="true"');
  });
});
