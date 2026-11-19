// A run of tool calls, folded into one row.
import { describe, expect, it } from "vitest";

import type { Block } from "./chat";
import { groupRows, groupSummary, type Row, type Tool } from "./toolGroups";

function tool(name: string, id = name + Math.random()): Block {
  return { kind: "tool", id, name, argsJson: "", args: {}, state: "done" };
}
const text = (t: string): Block => ({ kind: "text", text: t });
const thought = (t: string): Block => ({ kind: "thinking", text: t });

it("keeps a terminal agent stream error visible beside the preceding tool group", () => {
  const failure: Tool = {
    kind: "tool", id: "agent-error-m1", name: "Agent stream", argsJson: "", args: {},
    state: "error", result: "websocket closed by server before response.completed",
  };
  const rows = groupRows([tool("Bash"), failure]);
  expect(rows).toHaveLength(2);
  expect(rows[0].kind).toBe("group");
  expect(rows[1]).toMatchObject({ kind: "block", block: failure });
});

/** A row list. A group is "Bash|Bash+Bash": the folded run, then `+`, then the
 *  newest call — the one drawn whole on the bottom half of the same box. A lone
 *  block is just its name. */
function shape(rows: Row[]): string[] {
  return rows.map((r) =>
    r.kind === "group"
      ? `${r.tools.map((t) => t.name).join("|")}+${r.newest.name}`
      : r.block.kind === "tool"
        ? r.block.name
        : r.block.kind,
  );
}

describe("groupRows", () => {
  it("folds the first call into the activity row", () => {
    // The group UI now owns every foldable call, including a run's first one.
    // Its folded section is empty until a second call arrives.
    expect(shape(groupRows([tool("Bash")]))).toEqual(["+Bash"]);
  });

  it("folds two calls into one activity row", () => {
    expect(shape(groupRows([tool("Bash"), tool("Bash")]))).toEqual(["Bash+Bash"]);
  });

  it("keeps tool discovery and a sent message in the same activity row", () => {
    expect(shape(groupRows([tool("ToolSearch"), tool("SendMessage")]))).toEqual([
      "ToolSearch+SendMessage",
    ]);
  });

  it("folds a run and leaves its newest call out", () => {
    // The newest call is the one being watched — while a turn runs it is what
    // is happening right now, and when the turn is over it is where the run got
    // to. It never goes inside the fold.
    expect(shape(groupRows([tool("Bash"), tool("Bash"), tool("Bash")]))).toEqual([
      "Bash|Bash+Bash",
    ]);
  });

  it("folds an edit like any other call", () => {
    // An edit used to stand alone AND break the run around it, which is what
    // left the commonest turn there is — read, edit, read, edit — as a wall of
    // single cards. The tally names the file and the row counts the change, so
    // nothing about the edit is lost by folding it.
    const blocks = [
      ...Array.from({ length: 5 }, () => tool("Bash")),
      tool("Write"),
      tool("Edit"),
      ...Array.from({ length: 3 }, () => tool("Bash")),
    ];
    expect(shape(groupRows(blocks))).toEqual([
      "Bash|Bash|Bash|Bash|Bash|Write|Edit|Bash|Bash+Bash",
    ]);
  });

  it("folds the read-then-edit loop a turn is mostly made of", () => {
    const blocks = [tool("Read"), tool("Edit"), tool("Edit"), tool("Read"), tool("Bash")];
    expect(shape(groupRows(blocks))).toEqual(["Read|Edit|Edit|Read+Bash"]);
  });

  it("folds a failed edit while keeping the whole run marked failed", () => {
    const failed: Block = {
      kind: "tool",
      id: "boom",
      name: "Edit",
      argsJson: "",
      args: {},
      state: "error",
    };
    const blocks = [tool("Read"), tool("Edit"), failed, tool("Read"), tool("Edit"), tool("Read")];
    expect(shape(groupRows(blocks))).toEqual(["Read|Edit|Edit|Read|Edit+Read"]);
  });

  // A stop is different from a failure: it belongs at the exact point where
  // the reader interrupted it, while failures can be counted honestly on a
  // collapsed activity row.
  it("leaves the call a stop cut off where the reader can see it too", () => {
    const cut: Block = {
      kind: "tool",
      id: "cut",
      name: "Bash",
      argsJson: "",
      args: {},
      state: "stopped",
    };
    const blocks = [tool("Read"), tool("Edit"), tool("Read"), cut];
    expect(shape(groupRows(blocks))).toEqual(["Read|Edit+Read", "Bash"]);
  });

  it("mixes kinds in one group when they run together", () => {
    expect(shape(groupRows([tool("Bash"), tool("Read"), tool("Grep")]))).toEqual([
      "Bash|Read+Grep",
    ]);
  });

  it("breaks a run on prose", () => {
    const blocks = [
      tool("Bash"),
      tool("Bash"),
      text("checking"),
      tool("Bash"),
      tool("Bash"),
      tool("Bash"),
    ];
    expect(shape(groupRows(blocks))).toEqual(["Bash+Bash", "text", "Bash|Bash+Bash"]);
  });

  it("folds failed calls into the surrounding activity run", () => {
    const failed: Block = {
      kind: "tool",
      id: "boom",
      name: "Bash",
      argsJson: "",
      args: {},
      state: "error",
    };
    const blocks = [tool("Bash"), tool("Bash"), failed, tool("Bash"), tool("Bash"), tool("Bash")];
    expect(shape(groupRows(blocks))).toEqual(["Bash|Bash|Bash|Bash|Bash+Bash"]);
  });

  it("splits failed-call groups only when the agent speaks between them", () => {
    const failed = (id: string): Block => ({
      kind: "tool",
      id,
      name: "Bash",
      argsJson: "",
      args: {},
      state: "error",
    });
    const blocks = [
      failed("first"),
      tool("Bash", "success-between"),
      failed("second"),
      text("The first approach did not work, so I changed direction."),
      failed("third"),
      tool("Bash", "success-after"),
    ];

    expect(shape(groupRows(blocks))).toEqual([
      "Bash|Bash+Bash",
      "text",
      "Bash+Bash",
    ]);
  });

  it("never folds a subagent card away", () => {
    expect(shape(groupRows([tool("Task"), tool("Task"), tool("Task")]))).toEqual([
      "Task",
      "Task",
      "Task",
    ]);
  });

  it("ends one activity chain before and after a subagent event", () => {
    expect(
      shape(groupRows([tool("Read"), tool("Bash"), tool("Task"), tool("Read"), tool("Bash")])),
    ).toEqual(["Read+Bash", "Task", "Read+Bash"]);
  });

  it("never folds a skill away, because what follows it reads by its rules", () => {
    const skill: Block = { kind: "tool", id: "s1", name: "Skill", argsJson: "", args: { skill: "ship" }, state: "done" };
    expect(shape(groupRows([tool("Bash"), tool("Bash"), skill, tool("Bash"), tool("Bash")]))).toEqual([
      "Bash+Bash",
      "Skill",
      "Bash+Bash",
    ]);
  });

  it("keeps out any call the caller says has its own transcript", () => {
    const t = tool("Bash", "kept");
    expect(shape(groupRows([t, tool("Bash"), tool("Bash")], (x) => x.id === "kept"))).toEqual(["Bash", "Bash+Bash"]);
  });

  it("never folds an ask_user tool away", () => {
    expect(shape(groupRows([tool("Bash"), tool("ask_user"), tool("Bash")]))).toEqual([
      "+Bash",
      "ask_user",
      "+Bash",
    ]);
  });

  it("never folds an ask_user_questions tool away", () => {
    expect(shape(groupRows([tool("Bash"), tool("ask_user_questions"), tool("Bash")]))).toEqual([
      "+Bash",
      "ask_user_questions",
      "+Bash",
    ]);
  });

  it("never folds an MCP-qualified ask_user tool away", () => {
    expect(shape(groupRows([tool("Bash"), tool("mcp__octiq__ask_user"), tool("Bash")]))).toEqual([
      "+Bash",
      "mcp__octiq__ask_user",
      "+Bash",
    ]);
  });

  it("folds a run the agent thought its way through", () => {
    // What an interleaved-thinking turn actually looks like: look, think, look
    // again. Breaking the run on every thought left a wall of single cards.
    const blocks = [tool("Bash"), thought("a"), tool("Bash"), thought("b"), tool("Bash")];
    expect(shape(groupRows(blocks))).toEqual(["Bash|Bash+Bash"]);
  });

  it("leaves thinking out of the transcript altogether", () => {
    // Thinking is shown live above the composer while it happens, and nowhere
    // else. In the transcript it is a row that opens onto the agent talking to
    // itself, between the reader and the work.
    const blocks = [thought("a"), tool("Bash"), thought("b"), text("done")];
    expect(shape(groupRows(blocks))).toEqual(["+Bash", "text"]);
  });

  it("never lets a thought stand between two calls", () => {
    const blocks = [tool("Bash"), tool("Bash"), tool("Bash"), thought("a"), text("done")];
    expect(shape(groupRows(blocks))).toEqual(["Bash|Bash+Bash", "text"]);
  });

  it("folds two calls with a thought between them", () => {
    expect(shape(groupRows([tool("Bash"), thought("a"), tool("Bash")]))).toEqual(["Bash+Bash"]);
  });

  it("carries each row's position in the original block list", () => {
    const rows = groupRows([text("a"), tool("Bash"), tool("Bash"), tool("Bash"), text("b")]);
    // The last row has to know it is last, or the streaming prose stops typing.
    expect(rows.map((r) => r.index)).toEqual([0, 3, 4]);
  });
});

describe("groupSummary", () => {
  const bash = (command: string): Tool => ({
    kind: "tool",
    id: command,
    name: "Bash",
    argsJson: "",
    args: { command },
    state: "done",
  });

  const file = (name: string, file_path: string): Tool => ({
    kind: "tool",
    id: name + file_path,
    name,
    argsJson: "",
    args: { file_path },
    state: "done",
  });

  it("uses one plain-language clause per action kind", () => {
    expect(
      groupSummary([
        file("Read", "/work/app.ts"),
        file("Edit", "/work/app.ts"),
        file("Edit", "/work/other.ts"),
        bash("pnpm test"),
      ]),
    ).toEqual({ kind: "edit", label: "Edited files, read files, ran a command" });
  });

  it("counts a file once when several calls touched it", () => {
    expect(
      groupSummary([
        file("Read", "/work/app.ts"),
        file("Read", "/work/app.ts"),
        file("Edit", "/work/app.ts"),
      ]),
    ).toEqual({ kind: "edit", label: "Edited files, read files" });
  });

  it("keeps a many-kind summary to a single compact line", () => {
    const tools = [
      file("Edit", "/work/app.ts"),
      bash("pnpm test"),
      file("Read", "/work/other.ts"),
      tool("Grep", "search"),
      tool("WebSearch", "web"),
    ] as Tool[];
    expect(groupSummary(tools).label).toBe("Edited files, read files, ran a command, +2 more");
  });

  it("orders every summary by edit, then read, then commands", () => {
    const tools = [bash("pnpm test"), file("Read", "/work/app.ts"), file("Edit", "/work/app.ts")] as Tool[];
    expect(groupSummary(tools).label).toBe("Edited files, read files, ran a command");
  });
});

// Card 73 — a fenced block right after a tool card belongs INSIDE it.
describe("a code fence following a tool call", () => {
  const fence = (body: string, lang = "") => text("```" + lang + "\n" + body + "\n```");

  it("is taken out of the flow and attached to the call before it", () => {
    const rows = groupRows([tool("Bash"), fence("VERIFY RESULT: PASS")]);

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("group");
    expect((rows[0] as Extract<Row, { kind: "group" }>).note?.body).toBe("VERIFY RESULT: PASS");
  });

  it("keeps the fence's language, so the card can draw it as code", () => {
    const rows = groupRows([tool("Bash"), fence("cargo test", "sh")]);

    expect((rows[0] as Extract<Row, { kind: "block" }>).note?.lang).toBe("sh");
  });

  it("leaves a block that mixes prose and a fence exactly where it was", () => {
    // Only a block that is ENTIRELY one fence is unambiguous enough to move.
    // Prose around it is the agent talking, and that belongs in the reply.
    const mixed = text("Here is what happened:\n\n```\nboom\n```");
    const rows = groupRows([tool("Bash"), mixed]);

    expect(rows).toHaveLength(2);
    expect((rows[0] as Extract<Row, { kind: "block" }>).note).toBeUndefined();
  });

  it("leaves a fence that follows nothing alone", () => {
    const rows = groupRows([fence("just a snippet")]);

    expect(rows).toHaveLength(1);
    expect((rows[0] as Extract<Row, { kind: "block" }>).note).toBeUndefined();
  });

  it("leaves a fence that follows prose alone", () => {
    const rows = groupRows([text("look at this"), fence("just a snippet")]);

    expect(rows).toHaveLength(2);
  });

  it("does not attach to a GROUP, because no one tool in it owns the text", () => {
    const rows = groupRows([tool("Read"), tool("Read"), tool("Read"), fence("something")]);

    const group = rows.find((r) => r.kind === "group");
    expect(group).toBeDefined();
    // The fence stays a row of its own rather than picking a tool arbitrarily.
    expect(rows.filter((r) => r.kind === "block")).toHaveLength(1);
  });

  it("attaches only the FIRST fence, so a second stays in the reply", () => {
    const rows = groupRows([tool("Bash"), fence("one"), fence("two")]);

    expect(rows).toHaveLength(2);
    expect((rows[0] as Extract<Row, { kind: "block" }>).note?.body).toBe("one");
  });

  it("leaves a reply with no tool calls exactly as it was", () => {
    // Two rows, not three: thinking has never drawn a row of its own. That is
    // pre-existing behaviour and this card must not change it.
    const before = groupRows([text("a"), thought("b"), text("c")]);

    expect(before).toHaveLength(2);
    expect(before.every((r) => r.kind === "block" && !r.note)).toBe(true);
  });
});
