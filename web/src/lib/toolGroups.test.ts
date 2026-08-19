// A run of tool calls, folded into one row.
import { describe, expect, it } from "vitest";

import type { Block } from "./chat";
import { groupRows, groupTally, type Row, type Tool } from "./toolGroups";

function tool(name: string, id = name + Math.random()): Block {
  return { kind: "tool", id, name, argsJson: "", args: {}, state: "done" };
}
const text = (t: string): Block => ({ kind: "text", text: t });

/** A row list, as "Bash|Bash|Bash" for a group and "Read" for a lone block. */
function shape(rows: Row[]): string[] {
  return rows.map((r) =>
    r.kind === "group"
      ? r.tools.map((t) => t.name).join("|")
      : r.block.kind === "tool"
        ? r.block.name
        : r.block.kind,
  );
}

describe("groupRows", () => {
  it("leaves two calls in a row alone", () => {
    expect(shape(groupRows([tool("Bash"), tool("Bash")]))).toEqual(["Bash", "Bash"]);
  });

  it("folds three or more into one group", () => {
    expect(shape(groupRows([tool("Bash"), tool("Bash"), tool("Bash")]))).toEqual([
      "Bash|Bash|Bash",
    ]);
  });

  it("keeps Write and Edit out of every group", () => {
    // The example the rule was written from: Bash x5, Write x2, Bash x3.
    const blocks = [
      ...Array.from({ length: 5 }, () => tool("Bash")),
      tool("Write"),
      tool("Edit"),
      ...Array.from({ length: 3 }, () => tool("Bash")),
    ];
    expect(shape(groupRows(blocks))).toEqual([
      "Bash|Bash|Bash|Bash|Bash",
      "Write",
      "Edit",
      "Bash|Bash|Bash",
    ]);
  });

  it("mixes kinds in one group when they run together", () => {
    expect(shape(groupRows([tool("Bash"), tool("Read"), tool("Grep")]))).toEqual([
      "Bash|Read|Grep",
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
    expect(shape(groupRows(blocks))).toEqual(["Bash", "Bash", "text", "Bash|Bash|Bash"]);
  });

  it("leaves a failed call where the reader can see it", () => {
    const failed: Block = {
      kind: "tool",
      id: "boom",
      name: "Bash",
      argsJson: "",
      args: {},
      state: "error",
    };
    const blocks = [tool("Bash"), tool("Bash"), failed, tool("Bash"), tool("Bash"), tool("Bash")];
    expect(shape(groupRows(blocks))).toEqual(["Bash", "Bash", "Bash", "Bash|Bash|Bash"]);
  });

  it("never folds a subagent card away", () => {
    expect(shape(groupRows([tool("Task"), tool("Task"), tool("Task")]))).toEqual([
      "Task",
      "Task",
      "Task",
    ]);
  });

  it("keeps out any call the caller says has its own transcript", () => {
    const t = tool("Bash", "kept");
    expect(shape(groupRows([t, tool("Bash"), tool("Bash")], (x) => x.id === "kept"))).toEqual([
      "Bash",
      "Bash",
      "Bash",
    ]);
  });

  it("carries each row's position in the original block list", () => {
    const rows = groupRows([text("a"), tool("Bash"), tool("Bash"), tool("Bash"), text("b")]);
    // The last row has to know it is last, or the streaming prose stops typing.
    expect(rows.map((r) => r.index)).toEqual([0, 3, 4]);
  });
});

describe("groupTally", () => {
  const bash = (command: string): Block => ({
    kind: "tool",
    id: command,
    name: "Bash",
    argsJson: "",
    args: { command },
    state: "done",
  });

  it("counts a shell group by the command that ran", () => {
    const tools = [bash("python3 x.py"), bash("cd web && ls"), bash("python3 y.py")] as Tool[];
    expect(groupTally(tools)).toEqual([
      { label: "python3", count: 2 },
      { label: "cd", count: 1 },
    ]);
  });

  it("keeps the subcommand for the tools whose first word says nothing", () => {
    const tools = [bash("git status"), bash("git status -s"), bash("pnpm test")] as Tool[];
    expect(groupTally(tools)).toEqual([
      { label: "git status", count: 2 },
      { label: "pnpm test", count: 1 },
    ]);
  });

  it("reads past the environment a command was given", () => {
    expect(groupTally([bash("CI=true /usr/bin/python3 run.py")] as Tool[])).toEqual([
      { label: "python3", count: 1 },
    ]);
  });

  it("counts everything else by the name of the tool", () => {
    const tools = [tool("Read"), tool("Read"), tool("Grep")] as Tool[];
    expect(groupTally(tools)).toEqual([
      { label: "Read", count: 2 },
      { label: "Grep", count: 1 },
    ]);
  });
});
