import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskEvidence } from "../lib/taskEvidence";
import { TaskStatusCard } from "./TaskStatusCard";
import { DeliveryCard } from "./DeliveryCard";

const evidence: TaskEvidence = { turnId: "u1", objective: "Fix save", status: "settled", settled: true, files: [], checks: [], pins: [] };
const delivery = (value: TaskEvidence) => renderToStaticMarkup(<DeliveryCard evidence={value} onOpenFile={() => {}} onOpenGit={() => {}} />);

describe("task cards", () => {
  it("renders compact objective and actual blocker without claiming task success", () => {
    const html = renderToStaticMarkup(<TaskStatusCard evidence={{ ...evidence, status: "blocked", blocker: "Choose a project" }} />);
    expect(html).toContain("Fix save");
    expect(html).toContain("Needs you");
    expect(html).toContain("Choose a project");
    expect(html).not.toContain("success");
  });
  it("does not show a delivery during work or when connection is uncertain", () => {
    expect(delivery({ ...evidence, settled: false, status: "running" })).toBe("");
    expect(delivery({ ...evidence, settled: false, status: "unknown" })).toBe("");
  });
  it("makes missing edit and check evidence explicit", () => {
    const html = delivery(evidence);
    expect(html).toContain("No successful file edits recorded");
    expect(html).toContain("Checks may not have run");
    expect(html).toContain("Open Git diff");
  });
  it("distinguishes passed and unconfirmed checks and uses buttons for file actions", () => {
    const html = delivery({ ...evidence, files: ["src/save.ts"], checks: [{ id: "check", command: "npm test", status: "unknown" }], pins: [{ path: "result.html", label: "Preview" }] });
    expect(html).toContain("Result unconfirmed");
    expect(html).not.toContain("Passed");
    expect(html).toContain("src/save.ts</button>");
    expect(html).toContain("Preview</button>");
    expect(html).not.toContain("href=");
  });
});
