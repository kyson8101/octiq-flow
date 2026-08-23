// A Codex seat's replies, replayed from a real captured turn.
//
// Its own file, for the reason the other `.room` files give: `chat.test.ts`
// belongs to another piece of work in flight.
//
// The fixture is NOT hand-written. It is eleven verbatim lines lifted out of a
// real chat transcript — one complete turn by the Codex seat in this project's
// own room, `octiq_speaker` stamp and all, exactly as the browser receives it.
// That matters here more than usual: the whole bug was that nobody had looked
// at what Codex actually sends.
import { describe, expect, it } from "vitest";

import codexTurn from "./__fixtures__/codex-seat.jsonl?raw";
import { emptyChat, reduceChat, type ChatState, type Message } from "./chat";

function replay(text: string, start: ChatState = emptyChat()): ChatState {
  let state = start;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      state = reduceChat(state, JSON.parse(line));
    } catch {
      continue;
    }
  }
  return state;
}

const said = (m: Message) =>
  m.blocks.filter((b) => b.kind === "text").map((b) => ("text" in b ? b.text : "")).join("\n");

describe("a Codex seat answering", () => {
  const after = replay(codexTurn);

  it("says something at all", () => {
    // It answered nine times in the real chat and the screen showed nothing
    // once. Codex speaks `codex exec --json`'s thread/item protocol; the
    // reducer only knew Claude's, so every one of its events fell on the floor.
    expect(after.messages.length).toBeGreaterThan(0);
  });

  it("carries the words it actually wrote", () => {
    const all = after.messages.map(said).join("\n");

    expect(all).toContain("I’m Codex");
    expect(all).toContain("coding and problem-solving agent");
  });

  it("puts them under the seat's own name, not the host's", () => {
    // The events are stamped `octiq_speaker`, and a room's whole point is that
    // every message says which agent wrote it.
    const mine = after.messages.filter((m) => m.speaker?.id === "s1");

    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].speaker?.name).toBe("Codex");
    expect(mine[0].speaker?.agent).toBe("codex");
  });

  it("shows the commands it ran as tool cards", () => {
    // A `command_execution` is Codex running something. Drawn as a card, the
    // same as any other call, or a seat that spent a minute in the shell looks
    // like a seat that sat there saying nothing.
    const tools = after.messages.flatMap((m) => m.blocks.filter((b) => b.kind === "tool"));

    expect(tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(tools)).toContain("openai-docs");
  });

  it("marks a command as finished once its result is in", () => {
    const tools = after.messages.flatMap((m) =>
      m.blocks.filter((b): b is Extract<typeof b, { kind: "tool" }> => b.kind === "tool"),
    );

    // Nothing may be left spinning: the turn ended, so no card may claim to be
    // still running for the rest of the conversation.
    expect(tools.every((t) => t.state !== "running")).toBe(true);
  });

  it("is not left looking like it is still writing", () => {
    // `turn.completed` is Codex saying it has finished. Without it read, the
    // seat's last message streams forever.
    expect(after.messages.every((m) => !m.streaming)).toBe(true);
  });
});
