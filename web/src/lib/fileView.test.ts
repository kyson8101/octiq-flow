// Card 89 — the decisions both file frames were making separately.
import { describe, expect, it } from "vitest";

import { drawAs, hasTwoViews, saveState, type Preview } from "./fileView";

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

describe("an html file", () => {
  it("is drawn as a page, not as its own source", () => {
    // Same argument markdown already won: what an agent writes is meant to be
    // read, and a page read as source is worse than source read as a page.
    expect(drawAs("/p/report.html", text({ content: "<h1>Hi</h1>" }))).toBe("page");
    expect(drawAs("/p/Report.HTM", text({ content: "<h1>Hi</h1>" }))).toBe("page");
  });

  it("is the editor while there is nothing in it yet", () => {
    expect(drawAs("/p/new.html", text({ content: "" }))).toBe("code");
  });

  it("is nothing to edit when the backend says it is not text", () => {
    expect(drawAs("/p/odd.html", text({ kind: "binary" }))).toBe("none");
  });
});

describe("which files have a second view to flip to", () => {
  it("is the ones that are RENDERED — prose and pages", () => {
    expect(hasTwoViews("/p/notes.md", text({ content: "# Hi" }))).toBe(true);
    expect(hasTwoViews("/p/report.html", text({ content: "<h1>Hi</h1>" }))).toBe(true);
  });

  it("is not an ordinary source file, which has only the one", () => {
    expect(hasTwoViews("/p/x.ts", text())).toBe(false);
    expect(hasTwoViews("/p/spec.pdf", text({ kind: "pdf" }))).toBe(false);
  });

  it("is not a file that has not been read yet", () => {
    expect(hasTwoViews("/p/notes.md", null)).toBe(false);
  });
});
