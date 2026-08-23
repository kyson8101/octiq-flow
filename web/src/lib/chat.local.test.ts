// Card 80 — a local command's output never becomes a bubble you typed.
import { describe, expect, it } from "vitest";

import { emptyChat, reduceChat, type Block, type ChatState } from "./chat";

/** The envelope verbatim, as this project's own transcripts record it: the
 *  content is a bare STRING, and nothing marks the turn as machinery — no
 *  `isMeta`, no `isSynthetic`. That is the whole reason it read as typing. */
const stdout = (text: string) => ({
  type: "user",
  message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` },
  uuid: `u-${text.length}`,
});

const kinds = (state: ChatState): Block["kind"][] =>
  state.messages.flatMap((m) => m.blocks.map((b) => b.kind));

const said = (state: ChatState) =>
  state.messages.flatMap((m) => m.blocks.map((b) => ("text" in b ? b.text : "")));

describe("the CLI reporting on a command it ran itself", () => {
  it("never lands as a message on your side", () => {
    const after = reduceChat(emptyChat(), stdout("Set model to Opus 5 for this session only"));

    expect(after.messages.every((m) => m.role !== "user")).toBe(true);
  });

  it("never prints the wrapper", () => {
    const after = reduceChat(emptyChat(), stdout("Set model to Opus 5 for this session only"));

    expect(said(after).join("")).not.toContain("local-command");
  });

  it("keeps what the command actually reported", () => {
    const after = reduceChat(emptyChat(), stdout("Set model to Opus 5 for this session only"));

    expect(said(after).join("")).toContain("Set model to Opus 5 for this session only");
    expect(kinds(after)).toEqual(["notice"]);
  });

  it("draws nothing at all when the command said nothing", () => {
    // The commonest case by far. An empty quiet line between two turns is a gap
    // the reader has to account for.
    expect(reduceChat(emptyChat(), stdout("")).messages).toEqual([]);
  });

  it("does not repeat what the compaction rule above it already says", () => {
    // `/compact` reports `Compacted`, directly under a rule that says history
    // was summarised, what it cost, and who asked. The rule is strictly better,
    // and two lines for one event read as two events.
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", pre_tokens: 889000 },
    };
    const after = reduceChat(reduceChat(emptyChat(), boundary), stdout("Compacted "));

    expect(kinds(after)).toEqual(["compacted"]);
  });

  it("still keeps a real report that happens to follow a compaction", () => {
    // Only the acknowledgement is dropped, not everything after a boundary.
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 100 },
    };
    const after = reduceChat(reduceChat(emptyChat(), boundary), stdout("Set model to Opus 5"));

    expect(kinds(after)).toEqual(["compacted", "notice"]);
  });

  it("leaves a message that merely mentions the tag alone", () => {
    const typed = {
      type: "user",
      message: { role: "user", content: "what is <local-command-stdout> for?" },
      uuid: "u-typed",
    };
    const after = reduceChat(emptyChat(), typed);

    expect(after.messages[0].role).toBe("user");
    expect(said(after).join("")).toContain("<local-command-stdout>");
  });
});
