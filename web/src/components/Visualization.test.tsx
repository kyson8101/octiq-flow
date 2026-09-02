import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({ bridge: {} }));

import { parseVisualizationReference } from "./Visualization";

describe("visualization content references", () => {
  it("reads the path and supported presentation fields", () => {
    expect(
      parseVisualizationReference(
        '\nvisualize{"path":"/repo/chart.html","mode":"wide","title":"Chart"}\n',
      ),
    ).toEqual({ path: "/repo/chart.html", mode: "wide", title: "Chart" });
  });

  it("rejects malformed, relative, and unknown-mode references", () => {
    expect(parseVisualizationReference("visualizenope")).toBeNull();
    expect(parseVisualizationReference('visualize{"path":"chart.html"}')).toBeNull();
    expect(
      parseVisualizationReference('visualize{"path":"/chart.html","mode":"giant"}'),
    ).toBeNull();
  });
});
