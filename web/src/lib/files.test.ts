// The two things the files panel sorts its rows BY rather than collects them
// with: what kind of file each one is, and when it was last written.
//
// Both are formatting, and formatting is where the boring mistakes live — a
// dotfile counted as an extension, a file changed at 00:05 shown as yesterday,
// a date from another year that reads as this one. Dates here are built with
// the local-time `Date` constructor on both sides so the expectations do not
// depend on the machine's timezone.
import { describe, expect, it } from "vitest";

import { fileExt, fileTypes, formatModified, isHtml, modifiedTitle, typeLabel } from "./files";

describe("fileExt", () => {
  it("takes the extension from the NAME, not the path", () => {
    expect(fileExt("/a/b/main.rs")).toBe("rs");
    // A dot in a FOLDER name is not the file's extension.
    expect(fileExt("/home/me/.config/octiq/notes")).toBe("");
    expect(fileExt("/x/y/archive.tar.gz")).toBe("gz");
  });

  it("lowercases, so PNG and png are one type", () => {
    expect(fileExt("/shots/Screenshot.PNG")).toBe("png");
  });

  it("gives a dotfile and an extensionless file no type at all", () => {
    expect(fileExt("/repo/.gitignore")).toBe("");
    expect(fileExt("/repo/Makefile")).toBe("");
  });
});

describe("isHtml", () => {
  it("recognises both browser-page extensions without caring about case", () => {
    expect(isHtml("/repo/report.html")).toBe(true);
    expect(isHtml("/repo/report.HTM")).toBe(true);
    expect(isHtml("/repo/report.md")).toBe(false);
  });
});

describe("fileTypes", () => {
  it("counts each type, commonest first, ties by name", () => {
    expect(
      fileTypes(["/a/one.ts", "/a/two.ts", "/a/three.ts", "/a/z.rs", "/a/b.css"]),
    ).toEqual([
      { ext: "ts", count: 3 },
      { ext: "css", count: 1 },
      { ext: "rs", count: 1 },
    ]);
  });

  it("keeps the typeless files as their own bucket, last", () => {
    expect(fileTypes(["/a/Makefile", "/a/.env", "/a/one.ts"])).toEqual([
      { ext: "ts", count: 1 },
      { ext: "", count: 2 },
    ]);
  });

  it("labels the typeless bucket in words, and a real one by its extension", () => {
    expect(typeLabel("")).toBe("no extension");
    expect(typeLabel("ts")).toBe(".ts");
  });
});

describe("formatModified", () => {
  const now = new Date(2026, 7, 21, 14, 40); // Fri 21 Aug 2026, 14:40 local

  it("shows the clock time for a file changed today", () => {
    expect(formatModified(new Date(2026, 7, 21, 9, 5).getTime(), now)).toBe("09:05");
    // Still today at one minute past midnight, however far back that feels.
    expect(formatModified(new Date(2026, 7, 21, 0, 1).getTime(), now)).toBe("00:01");
  });

  it("shows the day and month for an older file this year", () => {
    expect(formatModified(new Date(2026, 7, 19, 23, 59).getTime(), now)).toBe("19 Aug");
    // 23:59 yesterday is minutes ago and still gets a date, because "23:59"
    // beside "14:40" would read as later today.
    expect(formatModified(new Date(2026, 7, 20, 23, 59).getTime(), now)).toBe("20 Aug");
  });

  it("adds the year once the file is from a different one", () => {
    expect(formatModified(new Date(2025, 11, 31, 12, 0).getTime(), now)).toBe("31 Dec 2025");
  });

  it("says nothing for a file it has no time for", () => {
    expect(formatModified(null, now)).toBe("");
    expect(formatModified(undefined, now)).toBe("");
  });

  it("spells the whole thing out for the hover text", () => {
    expect(modifiedTitle(new Date(2026, 7, 19, 9, 5).getTime())).toBe(
      "Modified 19 Aug 2026 at 09:05",
    );
    expect(modifiedTitle(null)).toBe("");
  });
});

