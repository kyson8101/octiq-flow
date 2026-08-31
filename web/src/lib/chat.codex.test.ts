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
import { addUserTurn, emptyChat, reduceChat, type ChatState, type Message } from "./chat";

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

  it("does not end the room's own turn", () => {
    // A seat's full stop is the end of the SEAT's turn. The host may be
    // part-way through one of its own — it is the one that asked, after all.
    const busy = { ...addUserTurn(emptyChat(), "host is working"), busy: true };
    const done = reduceChat(busy, {
      type: "turn.completed",
      octiq_speaker: { id: "s1", name: "Codex", agent: "codex" },
    });
    expect(done.busy).toBe(true);
  });
});

describe("a Codex chat of its own", () => {
  const durablePrompt = {
    type: "user",
    uuid: "user-1",
    octiq_user_turn: true,
    message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
  };

  it("rebuilds the prompt Codex itself never echoes", () => {
    const rebuilt = reduceChat(emptyChat(), durablePrompt);

    expect(rebuilt.messages).toHaveLength(1);
    expect(rebuilt.messages[0].role).toBe("user");
    expect(said(rebuilt.messages[0])).toBe("do the thing");

    const working = reduceChat(rebuilt, { type: "turn.started" }, 2);
    expect(working.messages[0].takenUp).toBe(true);
  });

  it("reconciles the durable prompt with its optimistic bubble in either order", () => {
    const sent = addUserTurn(emptyChat(), "do the thing", [], 1, undefined, "user-1");
    expect(reduceChat(sent, durablePrompt).messages).toHaveLength(1);

    const eventFirst = reduceChat(emptyChat(), durablePrompt);
    expect(addUserTurn(eventFirst, "do the thing", [], 1, undefined, "user-1").messages).toHaveLength(1);
  });

  it("takes the sent message out of the queue when its turn starts", () => {
    // Claude replays a user message when it begins it. Codex does not: this is
    // the one protocol event that says the prompt is no longer waiting.
    const sent = addUserTurn(emptyChat(), "do the thing");
    expect(sent.messages[0].takenUp).toBeUndefined();

    const working = reduceChat(sent, { type: "turn.started" }, 2);
    expect(working.busy).toBe(true);
    expect(working.messages[0].takenUp).toBe(true);
  });

  it("ends its turn on its own full stop", () => {
    // No seat, no room: `turn.completed` is this conversation's full stop, the
    // same thing Claude's `result` is. Left unread, the chat went on saying it
    // was working until its process exited — and a chat that says it is working
    // while nothing runs it is what `lib/carryOn` draws the cut-turn notice for.
    const busy = addUserTurn(emptyChat(), "do the thing");
    expect(busy.busy).toBe(true);

    const done = reduceChat(busy, { type: "turn.completed", usage: { output_tokens: 12 } });
    expect(done.busy).toBe(false);
  });
});
