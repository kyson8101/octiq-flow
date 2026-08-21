// The plan, pinned on screen — read back out of the transcript.
import { describe, expect, it } from "vitest";

import type { Block, Message } from "./chat";
import { latestTodos, todoLook } from "./todos";

function call(todos: unknown, name = "mcp__octiq__todo_write"): Block {
  return {
    kind: "tool",
    id: `t${Math.random()}`,
    name,
    argsJson: JSON.stringify({ todos }),
    args: { todos },
    state: "done",
  };
}

const turn = (blocks: Block[], parent?: string): Message => ({
  id: `m${Math.random()}`,
  role: "assistant",
  blocks,
  streaming: false,
  ...(parent ? { parent } : {}),
});

describe("latestTodos", () => {
  it("finds nothing in a conversation that never wrote a list", () => {
    expect(latestTodos([turn([{ kind: "text", text: "hello" }])])).toEqual([]);
  });

  it("takes the NEWEST list, not the first", () => {
    const messages = [
      turn([call([{ content: "one", status: "completed" }])]),
      turn([call([{ content: "one", status: "completed" }, { content: "two", status: "in_progress" }])]),
    ];
    expect(latestTodos(messages).map((t) => t.content)).toEqual(["one", "two"]);
  });

  it("ignores a subagent's own list", () => {
    // A subagent keeps a list of the one job it was given. Letting it through
    // would replace the plan on screen with one step of it.
    const messages = [
      turn([call([{ content: "the plan", status: "in_progress" }])]),
      turn([call([{ content: "a subagent's errand", status: "in_progress" }])], "task-1"),
    ];
    expect(latestTodos(messages).map((t) => t.content)).toEqual(["the plan"]);
  });

  it("reads Claude's own TodoWrite as well as ours", () => {
    const messages = [turn([call([{ content: "built in", status: "pending" }], "TodoWrite")])];
    expect(latestTodos(messages).map((t) => t.content)).toEqual(["built in"]);
  });

  it("drops rows that say nothing and defaults a status it cannot read", () => {
    const messages = [
      turn([
        call([
          { content: "  ", status: "pending" },
          { content: "real", status: "nonsense" },
          "not an object",
        ]),
      ]),
    ];
    expect(latestTodos(messages)).toEqual([{ content: "real", status: "pending" }]);
  });

  it("keeps the last list up while a new call is still arriving", () => {
    // A tool call streams its arguments in. Blinking the panel out and back in
    // between the two would be worse than showing the list a second late.
    const arriving: Block = {
      kind: "tool",
      id: "arriving",
      name: "mcp__octiq__todo_write",
      argsJson: '{"todos":[',
      args: undefined,
      state: "running",
    };
    const messages = [turn([call([{ content: "one", status: "pending" }])]), turn([arriving])];
    expect(latestTodos(messages).map((t) => t.content)).toEqual(["one"]);
  });
});

describe("todoLook", () => {
  it("counts what is done and says what is happening", () => {
    const look = todoLook([
      { content: "one", status: "completed" },
      { content: "two", status: "in_progress", activeForm: "Doing two" },
      { content: "three", status: "pending" },
    ]);
    expect(look).toEqual({ done: 1, total: 3, current: "Doing two", finished: false });
  });

  it("names the next step when nothing is marked in progress", () => {
    const look = todoLook([
      { content: "one", status: "completed" },
      { content: "two", status: "pending" },
    ]);
    expect(look.current).toBe("two");
    expect(look.finished).toBe(false);
  });

  it("knows when the whole list is done", () => {
    const look = todoLook([
      { content: "one", status: "completed" },
      { content: "two", status: "completed" },
    ]);
    expect(look).toEqual({ done: 2, total: 2, current: "", finished: true });
  });
});
