import { describe, expect, it } from "vitest";
import { PASTE_FILE_CHARS, PASTE_FILE_LINES, pastedTextLabel, pastedTextLines, pastedTextName, shouldSaveAsFile } from "./longPaste";

describe("long paste thresholds", () => {
  it.each(["a", "字", "😀"])("counts Unicode characters at the boundary: %s", (character) => {
    expect(shouldSaveAsFile(character.repeat(PASTE_FILE_CHARS - 1))).toBe(false);
    expect(shouldSaveAsFile(character.repeat(PASTE_FILE_CHARS))).toBe(true);
  });
  it.each(["\n", "\r\n", "\r"])("counts lines split by %j", (separator) => {
    expect(shouldSaveAsFile(Array(PASTE_FILE_LINES - 1).fill("字😀").join(separator))).toBe(false);
    expect(shouldSaveAsFile(Array(PASTE_FILE_LINES).fill("字😀").join(separator))).toBe(true);
  });
  it("counts mixed line endings and a trailing empty line", () => {
    expect(pastedTextLines("a\r\nb\rc\n")).toBe(4);
    expect(shouldSaveAsFile("")).toBe(false);
  });
  it("names files using local calendar and clock fields", () => {
    expect(pastedTextName(new Date(2026, 0, 2, 3, 4, 5))).toBe("pasted-text-20260102-030405.txt");
  });
  it("labels singular and grouped line counts", () => {
    expect(pastedTextLabel("字😀")).toBe("Pasted text · 1 line");
    expect(pastedTextLabel(Array(1234).fill("字😀").join("\r\n"))).toBe("Pasted text · 1,234 lines");
  });
});
