import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));

import { FolderPicker } from "./FolderPicker";

function render(start: string, files = false) {
  return renderToStaticMarkup(
    <FolderPicker start={start} title="Main folder" onPick={() => {}} onClose={() => {}} files={files} />,
  );
}

describe("FolderPicker", () => {
  it.each([
    "C:\\Works\\VS-GitHub\\octiq-flow",
    "D:/Projects/octiq-flow",
    "C:\\",
    "\\\\server\\share\\project",
    "/Users/kyson/projects",
    "/",
  ])("allows selecting the absolute folder %s", (path) => {
    const button = render(path).match(/<button[^>]*>Use this folder<\/button>/)?.[0];
    expect(button).toBeDefined();
    expect(button).not.toContain("disabled");
  });

  it.each(["", "~", "projects", "C:", "C:projects", "\\projects", "\\\\server"])(
    "requires an absolute folder before selecting %s", (path) => {
      expect(render(path)).toMatch(/<button[^>]*disabled=""[^>]*>Use this folder<\/button>/);
    },
  );

  it.each(["C:\\Works", "D:/Projects", "\\\\server\\share\\project", "/Users"])(
    "offers parent navigation inside %s", (path) => {
      expect(render(path)).toContain('class="fp-picker-row is-up"');
    },
  );

  it.each(["C:\\", "D:/", "\\\\server\\share", "//server/share", "/"])(
    "does not navigate above the root %s", (path) => {
      expect(render(path)).not.toContain('class="fp-picker-row is-up"');
    },
  );

  it("keeps file mode selection in the file list", () => {
    expect(render("C:\\Works", true)).not.toContain("Use this folder");
  });
});
