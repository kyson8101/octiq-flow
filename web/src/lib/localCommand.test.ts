// Card 80 — reading the CLI's own report on a slash command it handled itself.
import { describe, expect, it } from "vitest";

import { parseLocalOutput } from "./localCommand";

describe("a local command's output", () => {
  it("is nothing for anything a person actually typed", () => {
    expect(parseLocalOutput("commit and push")).toBeNull();
    expect(parseLocalOutput("/compact")).toBeNull();
    // Not a wrapper — a person quoting one. Taken as the CLI speaking, the
    // sentence would be lifted out of their message and shown as a report.
    expect(parseLocalOutput("what is <local-command-stdout> for?")).toBeNull();
  });

  it("reads the report out of the wrapper", () => {
    expect(parseLocalOutput("<local-command-stdout>Set model to Opus 5</local-command-stdout>"))
      .toBe("Set model to Opus 5");
  });

  it("reads stderr the same way", () => {
    // Same wrapper, different stream. A failure report is if anything the one
    // most worth showing.
    expect(parseLocalOutput("<local-command-stderr>No such command</local-command-stderr>"))
      .toBe("No such command");
  });

  it("comes back empty when the command said nothing", () => {
    // The commonest case by far. Empty, not null: the turn IS a local command's
    // output, it just has nothing in it — and the caller has to be able to tell
    // that from something a person typed.
    expect(parseLocalOutput("<local-command-stdout></local-command-stdout>")).toBe("");
    expect(parseLocalOutput("<local-command-stdout>   \n </local-command-stdout>")).toBe("");
  });

  it("strips the colouring the terminal was meant to eat", () => {
    // Real, from this project's own transcripts: the CLI dims its
    // acknowledgement, and the escapes reach us verbatim because there is no
    // terminal here to consume them.
    const dimmed = "\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m";

    expect(parseLocalOutput(`<local-command-stdout>${dimmed}</local-command-stdout>`))
      .toBe("Compacted (ctrl+o to see full summary)");
  });

  it("keeps a report that runs to several lines", () => {
    const body = "line one\nline two";

    expect(parseLocalOutput(`<local-command-stdout>${body}</local-command-stdout>`)).toBe(body);
  });
});
