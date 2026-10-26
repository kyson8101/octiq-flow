import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: vi.fn() } }));
import { DiskReportPage } from "./DiskPage";
import fixture from "../lib/__fixtures__/disk-report.json";
import { readDiskReport } from "../lib/diskReport";

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
