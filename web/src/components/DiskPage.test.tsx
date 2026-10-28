import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: vi.fn() } }));
import { DiskMap, DiskReportPage } from "./DiskPage";
import fixture from "../lib/__fixtures__/disk-report.json";
import { readDiskReport } from "../lib/diskReport";
import { crowdedDiskReport } from "../lib/diskReport.fixture";
import diskCss from "./DiskPage.css?raw";
import { lf } from "../lib/sourceText";

const render = (over: Partial<Parameters<typeof DiskReportPage>[0]> = {}) => renderToStaticMarkup(<DiskReportPage report={readDiskReport(fixture)} onClose={() => {}} onScan={() => {}} {...over} />);
describe("Disk report page", () => {
  it("renders the fixture groups, worktree checks, growth and explicit warnings", () => {
    const html = render();
    for (const text of ["Safe to clean", "Review first", "Your work", "Video project", "+500 MB since", "Not recommended to delete", "Working tree clean", "Merged to mainline", "Not a mainline worktree", "Not in use", "280 MB", "Git does not protect these files", "1 folders skipped", "OctiqFlow never deletes anything", "Select at least one item", "Items with no tool command are printed as Skipped."]) expect(html).toContain(text);
    expect(html).not.toContain('checked=""');
    expect(html.match(/type="checkbox"/g)).toHaveLength(10); // 7 rows, 2 sections, 1 rm switch; no work checkbox
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(html).toContain("No safe cleanup command for this item");
    expect(html).toContain('title="/Users/demo/Downloads/custom-sdk-release-with-a-very-long-filename.tar.gz"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('bash ~/Downloads/disk-cleanup.sh');
    expect(html).not.toContain('class="disk-progress"');
  });
  it("renders missing-host errors verbatim and partial reports without crashing", () => {
    expect(render({ report: null, error: "'disk_scan_state' is not available on this backend — it may be older than the page asking for it" })).toContain("is not available on this backend");
    expect(render({ report: readDiskReport({ scanId: "partial" }) })).toContain("No items in this section.");
  });
  it("shows progress and Windows terminal form", () => {
    const html = render({ report: { ...readDiskReport(fixture)!, platform: "windows" }, running: { scanId: "new", phase: "git", entries: 1234, bytes: 450000000 } });
    expect(html).toContain("Cancel scan");
    expect(html).toContain("Git worktrees · 1,234 entries · 450 MB counted");
    expect(html).toContain("powershell -File");
    expect(html).toContain("Wait for the scan to finish");
  });
});


describe("disk map aggregates", () => {
  it("keeps aggregate buttons descriptive and Work non-actionable", () => {
    const html = renderToStaticMarkup(<DiskMap items={crowdedDiskReport().items} selected={new Set(["worktree-2", "archive-1"])} onFocus={() => {}} />);
    expect(html).toContain("Linked Git worktrees, 70 items,");
    expect(html).toMatch(/Linked Git worktrees, 70 items,[^"<>]+1 ticked. Find in Review first/);
    expect(html).toMatch(/Other, 17 items,[^"<>]+1 ticked. Find in Review first/);
    expect(html).toContain("Media exports, 38 items,");
    expect(html).toContain("Your work is labelled only.");
    expect(html.match(/class="disk-tile-content"/g)).toHaveLength(8);
    expect(html.match(/<button type="button" class="disk-tile/g)).toHaveLength(7);
    expect(html).not.toContain("Find in Your work");
    expect(html).toContain("Other · 1 ticked");
    expect(html).toContain('data-fit="none"'); // hidden until real layout is measured
  });
  it("ellipsizes a whole single label line and never clamps vertical fragments", () => {
    const css = lf(diskCss);
    expect(css).toMatch(/\.disk-tile-label \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis/);
    expect(css).not.toContain("-webkit-line-clamp");
    expect(css).toContain('[data-fit="none"]');
    expect(css).toContain('[data-fit="size"]');
  });
});
