import { describe, expect, it } from "vitest";
import { parentFolderPath, visiblePickerEntries, type FolderEntry } from "./folderPicker";

describe("parentFolderPath", () => {
  it.each<[string, string | null]>([
    ["C:\\Works\\VS-GitHub\\octiq-flow", "C:\\Works\\VS-GitHub"],
    ["C:\\Works\\", "C:\\"],
    ["C:\\", null],
    ["D:/Projects/octiq-flow/", "D:/Projects"],
    ["D:/Projects", "D:/"],
    ["D:/", null],
    ["C:/Works\\project", "C:/Works"],
    ["\\\\server\\share\\project", "\\\\server\\share"],
    ["\\\\server\\share\\", null],
    ["\\\\server\\share", null],
    ["//server/share/project/", "//server/share"],
    ["//server/share/", null],
    ["/Users/kyson/", "/Users"],
    ["/Users", "/"],
    ["/a", "/"],
    ["/", null],
    ["/tmp/name\\with\\backslashes", "/tmp"],
    ["C:Works", null],
    ["", null],
  ])("navigates from %s to %s", (path, parent) => {
    expect(parentFolderPath(path)).toBe(parent);
  });
});

describe("visiblePickerEntries", () => {
  const entries: FolderEntry[] = [
    { name: ".git", path: "C:\\Works\\.git", is_dir: true },
    { name: "Hidden", path: "C:\\Works\\Hidden", is_dir: true, is_hidden: true },
    { name: "project", path: "C:\\Works\\project", is_dir: true, is_hidden: false },
    { name: "project.v2", path: "C:\\Works\\project.v2", is_dir: true },
    { name: ".env", path: "C:\\Works\\.env", is_dir: false, is_hidden: true },
    { name: "README.md", path: "C:\\Works\\README.md", is_dir: false },
  ];

  it("hides dot folders and Windows hidden folders while retaining visible folders", () => {
    expect(visiblePickerEntries(entries, false).map((entry) => entry.name)).toEqual([
      "project", "project.v2",
    ]);
  });

  it("keeps files available in file mode without showing hidden folders", () => {
    expect(visiblePickerEntries(entries, true).map((entry) => entry.name)).toEqual([
      "project", "project.v2", ".env", "README.md",
    ]);
  });
});
