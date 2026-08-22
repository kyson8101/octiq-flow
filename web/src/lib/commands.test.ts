// A project's saved commands, as read back from the backend.
//
// The list arrives with the project on `list_workspaces`, so it comes from a
// file written by an older build of this app and by the vanilla desktop UI
// before it. Reading it has to survive that, which is what these pin down.
import { describe, expect, it } from "vitest";

import { isReady, parseCommands, sameCommand } from "./commands";

describe("reading a project's saved commands", () => {
  it("keeps the rows a person can actually run", () => {
    const rows = parseCommands([
      { id: "a", label: "dev", command: "pnpm dev" },
      { id: "b", label: " test ", command: " cargo test " },
    ]);
    expect(rows).toEqual([
      { id: "a", label: "dev", command: "pnpm dev" },
      { id: "b", label: "test", command: "cargo test" },
    ]);
  });

  it("drops a row with nothing to run or nothing to click", () => {
    // A button with no label is a blank chip; one with no command does nothing
    // when pressed. Both are worse than not being drawn.
    expect(
      parseCommands([
        { id: "a", label: "dev", command: "   " },
        { id: "b", label: "", command: "pnpm dev" },
        { id: "", label: "dev", command: "pnpm dev" },
        { id: "c", label: 7, command: "pnpm dev" },
        null,
        "not a row",
      ]),
    ).toEqual([]);
  });

  it("treats a project with no commands, or a broken list, as none", () => {
    expect(parseCommands(undefined)).toEqual([]);
    expect(parseCommands(null)).toEqual([]);
    expect(parseCommands({ actions: [] })).toEqual([]);
  });
});

describe("the add / edit form", () => {
  it("is ready only once both fields say something", () => {
    expect(isReady("dev", "pnpm dev")).toBe(true);
    expect(isReady("  ", "pnpm dev")).toBe(false);
    expect(isReady("dev", "   ")).toBe(false);
  });

  it("knows when nothing was actually changed", () => {
    // Saving an unchanged row is a write to disk and a project reload for
    // nothing — closing the form is the whole of the right answer.
    const row = { id: "a", label: "dev", command: "pnpm dev" };
    expect(sameCommand(row, " dev ", "pnpm dev ")).toBe(true);
    expect(sameCommand(row, "dev", "pnpm dev --host")).toBe(false);
    expect(sameCommand(row, "web", "pnpm dev")).toBe(false);
  });
});
