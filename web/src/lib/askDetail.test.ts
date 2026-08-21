import { describe, expect, it } from "vitest";
import { askDetail } from "./askDetail";

describe("askDetail", () => {
  it("shows a command in full, because what it runs is the whole question", () => {
    const d = askDetail({ command: "rm -rf build" });
    expect(d).toEqual({ label: "command", body: "rm -rf build", limit: 1200 });
  });

  it("shows what a write is about to put in the file", () => {
    expect(askDetail({ content: "hello" })?.label).toBe("content");
    expect(askDetail({ new_string: "after" })?.label).toBe("replacing with");
  });

  it("shows the plan ExitPlanMode is asking you to approve", () => {
    // Plan mode reaches this card and nowhere else. `ExitPlanMode` arrives as
    // an ordinary permission question whose only argument is the plan, so a
    // card that cannot read `plan` shows three buttons and no plan — approval
    // for something you were never shown.
    const plan = "## Step 1\nAdd the flag.\n\n## Step 2\nPrint and exit.";
    expect(askDetail({ plan })).toEqual({ label: "plan", body: plan, limit: 8000 });
  });

  it("does not trim a plan to the length of a file preview", () => {
    // A preview is a sample and may stop early. A plan is the thing being
    // decided, and one cut off part-way cannot be judged at all.
    const long = "x".repeat(5000);
    const d = askDetail({ plan: long });
    expect(d!.limit).toBeGreaterThan(long.length);
    expect(askDetail({ content: long })!.limit).toBeLessThan(long.length);
  });

  it("says nothing rather than dumping arguments it does not understand", () => {
    expect(askDetail({ file_path: "/tmp/a" })).toBeNull();
    expect(askDetail({})).toBeNull();
    expect(askDetail(null)).toBeNull();
    expect(askDetail(undefined)).toBeNull();
  });

  it("ignores an argument that is present but empty", () => {
    // Arguments stream in as JSON fragments, so an empty string is a value that
    // has not arrived yet, not a value of its own.
    expect(askDetail({ command: "" })).toBeNull();
    expect(askDetail({ plan: "" })).toBeNull();
  });

  it("still says 'replacing with' when the replacement is nothing", () => {
    // An edit whose new_string is empty is a DELETION, and that is worth
    // showing. Only the key being absent means there is nothing to say.
    expect(askDetail({ new_string: "" })).toEqual({
      label: "replacing with",
      body: "",
      limit: 1200,
    });
  });
});
