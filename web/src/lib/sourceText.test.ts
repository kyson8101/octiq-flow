// A test that reads source as text must read the same thing on a CRLF
// checkout (Git for Windows' default) as on an LF one.
import { describe, expect, it } from "vitest";
import panel from "../components/OrchestrationPanel.tsx?raw";
import { lf } from "./sourceText";

describe("source read as text", () => {
  it("has one kind of line end, whichever the checkout gave it", () => {
    expect(lf("a\r\nb\r\n")).toBe("a\nb\n");
    expect(lf("a\nb")).toBe("a\nb");
    expect(lf("a\rb")).toBe("a\nb");
    expect(lf("")).toBe("");
  });

  it("makes the pattern that failed on Windows match a CRLF copy of the file", () => {
    // `taskStart.test.tsx` cut the delivery row out of the panel with a
    // pattern ending in `\n`. On a CRLF checkout it matched nothing, and
    // the `![0]` after it threw.
    const cut = /\{task\.workspace && !readOnly && <DeliveryActions [\s\S]*?\/>\}\n/;
    const unix = lf(panel);
    const windows = unix.replace(/\n/g, "\r\n");
    expect(cut.exec(unix)).not.toBeNull();
    expect(cut.exec(windows)).toBeNull();
    expect(cut.exec(lf(windows))![0]).toBe(cut.exec(unix)![0]);
  });
});
