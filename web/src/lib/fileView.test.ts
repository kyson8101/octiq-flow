// Card 89 — the decisions both file frames were making separately.
import { describe, expect, it } from "vitest";

import { drawAs, saveState, type Preview } from "./fileView";

const text = (over: Partial<Preview> = {}): Preview => ({
  kind: "text",
  content: "const a = 1;",
  truncated: false,
  size: 12,
  ...over,
});

describe("what a file should be drawn as", () => {
  it("is the editor for an ordinary text file", () => {
    expect(drawAs("/p/x.ts", text())).toBe("code");
  });

  it("is rendered prose for markdown", () => {
    // Most of what an agent writes is prose, and prose read as source is worse
    // than source read as prose.
    expect(drawAs("/p/notes.md", text())).toBe("prose");
    expect(drawAs("/p/README.MD", text())).toBe("prose");
  });

  it("is the editor for markdown with nothing in it", () => {
    // A rendered empty file is a blank page with no way to start typing.
    expect(drawAs("/p/new.md", text({ content: "" }))).toBe("code");
    expect(drawAs("/p/new.md", text({ content: "   \n " }))).toBe("code");
  });

  it("is a picture for an image, whatever it is called", () => {
    expect(drawAs("/p/shot.png", text({ kind: "image" }))).toBe("image");
  });

  it("is nothing to edit for a PDF or a binary", () => {
    expect(drawAs("/p/spec.pdf", text({ kind: "pdf" }))).toBe("none");
    expect(drawAs("/p/a.bin", text({ kind: "binary" }))).toBe("none");
  });

  it("trusts the backend's kind over the file's name", () => {
    // `read_file_preview` has opened the thing. A `.md` that came back as
    // binary is binary, whatever the extension claims.
    expect(drawAs("/p/notes.md", text({ kind: "binary" }))).toBe("none");
  });
});

describe("whether a file may be saved", () => {
  it("is no while nothing has been changed", () => {
    expect(saveState(text(), "const a = 1;").can).toBe(false);
  });

  it("is yes once it differs from what was read", () => {
    expect(saveState(text(), "const a = 2;").can).toBe(true);
  });

  it("is REFUSED for a truncated file, not merely discouraged", () => {
    // The backend caps how much of a large file it returns. Writing that back
    // would cut the real file down to the part we happened to be shown, so this
    // is a refusal with a reason rather than a warning to click past.
    const cut = saveState(text({ truncated: true }), "changed");

    expect(cut.can).toBe(false);
    expect(cut.why).toContain("cut");
  });

  it("is no for anything that is not text", () => {
    expect(saveState(text({ kind: "image" }), "anything").can).toBe(false);
  });

  it("is no when the file has not been read yet", () => {
    expect(saveState(null, "typing into nothing").can).toBe(false);
  });

  it("reports dirtiness apart from savability", () => {
    // A truncated file that has been edited IS dirty — closing it should still
    // ask. It just cannot be written.
    const cut = saveState(text({ truncated: true }), "changed");

    expect(cut.dirty).toBe(true);
    expect(cut.can).toBe(false);
  });
});
