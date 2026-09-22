import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({
  bridge: { invoke: vi.fn() },
}));

import { ProjectSettings } from "./ProjectSettings";

describe("ProjectSettings", () => {
  it("offers a picker, editable hex code, automatic reset, and matching preview", () => {
    const project = {
      id: "p1",
      name: "octiq-flow",
      primary_path: "/work/octiq-flow",
      color: "#12ab34",
    };
    const html = renderToStaticMarkup(
      <ProjectSettings
        project={project}
        projects={[project]}
        onChanged={() => {}}
        onClose={() => {}}
        onDeleted={() => {}}
      />,
    );

    expect(html).toContain("Project identity");
    expect(html).toContain('type="color"');
    expect(html).toContain('aria-label="Choose project color"');
    expect(html).toContain('aria-label="Project color hex code"');
    expect(html).toContain('value="#12ab34"');
    expect(html).toContain("Automatic</button>");
    expect(html).toContain("--project-color:#12ab34");
  });
});
