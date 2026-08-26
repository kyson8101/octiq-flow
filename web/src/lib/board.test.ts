// Which chats want something from you, and which are getting on with it.
import { describe, expect, it } from "vitest";

import { QUIET_MAX, buildBoard, type BoardInput } from "./board";
import type { Todo } from "./todos";

/** A conversation, as the sidebar's store holds one. Only the fields the board
 *  reads are set; the rest of `Conversation` is beside the point here. */
function chat(id: string, over: { title?: string; updatedAt?: number } = {}) {
  return {
    id,
    projectId: "p1",
    title: over.title ?? id,
    createdAt: 0,
    updatedAt: over.updatedAt ?? 0,
    messages: [],
  };
}

/** A loaded transcript whose newest `todo_write` call holds `todos`. */
function loaded(todos: Todo[]) {
  return {
    messages: [
      {
        id: "m1",
        role: "assistant" as const,
        streaming: false,
        blocks: [
          {
            kind: "tool" as const,
            id: "t1",
            name: "mcp__octiq__todo_write",
            argsJson: "",
            args: { todos },
            state: "done" as const,
          },
        ],
      },
    ],
  };
}

function input(over: Partial<BoardInput> = {}): BoardInput {
  return {
    conversations: [],
    running: new Set(),
    busy: new Set(),
    asks: {},
    questions: {},
    chats: {},
    ...over,
  };
}

/** The card for `id`, wherever it landed. */
function cardOf(board: ReturnType<typeof buildBoard>, id: string) {
  for (const column of board.columns) {
    const found = column.cards.find((c) => c.id === id);
    if (found) return found;
  }
  return undefined;
}

describe("buildBoard columns", () => {
  it("puts a chat holding a permission card under Needs you", () => {
    const board = buildBoard(
      input({
        conversations: [chat("a")],
        running: new Set(["a"]),
        asks: { a: [{ id: "ask1", toolName: "Bash" }] },
      }),
    );
    expect(cardOf(board, "a")?.column).toBe("needs-you");
    expect(cardOf(board, "a")?.waiting?.kind).toBe("permission");
  });

  it("puts a chat holding an ask_user question under Needs you", () => {
    const board = buildBoard(
      input({
        conversations: [chat("a")],
        running: new Set(["a"]),
        questions: { a: [{ id: "q1", question: "Which one?" }] },
      }),
    );
    expect(cardOf(board, "a")?.column).toBe("needs-you");
    expect(cardOf(board, "a")?.waiting).toEqual({
      kind: "question",
      summary: "Which one?",
    });
  });

  it("keeps a busy chat under Needs you when it is also waiting on an answer", () => {
    // A turn IS in flight — the agent is blocked inside it, on you. Reading the
    // busy flag first would file the one chat that cannot move on under the
    // column for the ones that are moving.
    const board = buildBoard(
      input({
        conversations: [chat("a")],
        running: new Set(["a"]),
        busy: new Set(["a"]),
        asks: { a: [{ id: "ask1", toolName: "Bash" }] },
      }),
    );
    expect(cardOf(board, "a")?.column).toBe("needs-you");
  });

  it("shows the permission first when a chat holds both", () => {
    // Three minutes against ten (App.tsx): the permission is the one that runs
    // out while you are reading the other.
    const board = buildBoard(
      input({
        conversations: [chat("a")],
        running: new Set(["a"]),
        asks: { a: [{ id: "ask1", toolName: "Bash" }] },
        questions: { a: [{ id: "q1", question: "Which one?" }] },
      }),
    );
    expect(cardOf(board, "a")?.waiting?.kind).toBe("permission");
  });

  it("puts a chat mid-turn under Working", () => {
    const board = buildBoard(
      input({
        conversations: [chat("a")],
        running: new Set(["a"]),
        busy: new Set(["a"]),
      }),
    );
    expect(cardOf(board, "a")?.column).toBe("working");
  });

  it("puts a live chat between turns under Idle", () => {
    const board = buildBoard(
      input({ conversations: [chat("a")], running: new Set(["a"]) }),
    );
    expect(cardOf(board, "a")?.column).toBe("idle");
  });

  it("puts a chat with no process under Quiet", () => {
    const board = buildBoard(input({ conversations: [chat("a")] }));
    expect(cardOf(board, "a")?.column).toBe("quiet");
  });

  it("gives every chat exactly one card", () => {
    const board = buildBoard(
      input({
        conversations: [chat("a"), chat("b"), chat("c")],
        running: new Set(["a", "b"]),
        busy: new Set(["b"]),
      }),
    );
    const ids = board.columns.flatMap((c) => c.cards.map((card) => card.id));
    expect(ids.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("buildBoard card face", () => {
  it("reads the plan out of a loaded transcript", () => {
    const board = buildBoard(
      input({
        conversations: [chat("a")],
        running: new Set(["a"]),
        busy: new Set(["a"]),
        chats: {
          a: loaded([
            { content: "One", status: "completed" },
            { content: "Two", status: "in_progress", activeForm: "Doing two" },
          ]),
        },
      }),
    );
    expect(cardOf(board, "a")?.plan).toMatchObject({
      done: 1,
      total: 2,
      current: "Doing two",
    });
  });

  it("has no plan for a chat whose transcript is not in memory", () => {
    // Running but never opened this session. The column is still right; the
    // face falls back to the title, and loading every transcript to fix that
    // costs megabytes per chat on a phone (App.tsx).
    const board = buildBoard(
      input({ conversations: [chat("a", { title: "Fix the top bar" })], running: new Set(["a"]) }),
    );
    expect(cardOf(board, "a")?.plan).toBeUndefined();
    expect(cardOf(board, "a")?.title).toBe("Fix the top bar");
  });

  it("marks an idle chat that stopped part-way through its plan", () => {
    const board = buildBoard(
      input({
        conversations: [chat("a")],
        running: new Set(["a"]),
        chats: {
          a: loaded([
            { content: "One", status: "completed" },
            { content: "Two", status: "pending" },
          ]),
        },
      }),
    );
    expect(cardOf(board, "a")?.stalled).toBe(true);
  });

  it("does not mark an idle chat that finished its plan", () => {
    const board = buildBoard(
      input({
        conversations: [chat("a")],
        running: new Set(["a"]),
        chats: { a: loaded([{ content: "One", status: "completed" }]) },
      }),
    );
    expect(cardOf(board, "a")?.stalled).toBeFalsy();
    expect(cardOf(board, "a")?.plan?.finished).toBe(true);
  });

  it("does not mark a chat that is still working through its plan", () => {
    // Unfinished items are the normal state of a turn in flight. Only a chat
    // that has STOPPED with items left has stalled.
    const board = buildBoard(
      input({
        conversations: [chat("a")],
        running: new Set(["a"]),
        busy: new Set(["a"]),
        chats: { a: loaded([{ content: "One", status: "pending" }]) },
      }),
    );
    expect(cardOf(board, "a")?.stalled).toBeFalsy();
  });
});

describe("buildBoard ordering and the quiet cap", () => {
  it("puts the most recently touched chat at the top of its column", () => {
    const board = buildBoard(
      input({
        conversations: [
          chat("old", { updatedAt: 10 }),
          chat("new", { updatedAt: 30 }),
          chat("mid", { updatedAt: 20 }),
        ],
        running: new Set(["old", "new", "mid"]),
      }),
    );
    const idle = board.columns.find((c) => c.column === "idle");
    expect(idle?.cards.map((c) => c.id)).toEqual(["new", "mid", "old"]);
  });

  it("caps the Quiet column and says how many it left out", () => {
    // Quiet is every chat that ever was. Uncapped it stops being a board and
    // becomes a second sidebar.
    const many = Array.from({ length: QUIET_MAX + 5 }, (_, i) =>
      chat(`c${i}`, { updatedAt: i }),
    );
    const board = buildBoard(input({ conversations: many }));
    const quiet = board.columns.find((c) => c.column === "quiet");
    expect(quiet?.cards).toHaveLength(QUIET_MAX);
    expect(quiet?.hidden).toBe(5);
  });

  it("reports nothing hidden when the quiet column fits", () => {
    const board = buildBoard(input({ conversations: [chat("a")] }));
    expect(board.columns.find((c) => c.column === "quiet")?.hidden).toBe(0);
  });
});

describe("buildBoard totals", () => {
  it("counts what is waiting on you, for a badge", () => {
    const board = buildBoard(
      input({
        conversations: [chat("a"), chat("b"), chat("c")],
        running: new Set(["a", "b", "c"]),
        asks: { a: [{ id: "ask1", toolName: "Bash" }] },
        questions: { b: [{ id: "q1", question: "Which?" }] },
      }),
    );
    expect(board.needsYou).toBe(2);
  });
});
