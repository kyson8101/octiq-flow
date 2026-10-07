import { describe, expect, it } from "vitest";
import { readCodexEvent } from "./codexEvents";
import { groupRows, type Tool } from "./toolGroups";
import { toolPicture } from "./toolKind";

// Shapes as Codex wrote them (trimmed from real chat records; the base64
// `result` is megabytes long in the original).
const generated = {
  type: "item.completed",
  item: {
    id: "exec-ca00", type: "image_generation", status: "completed", failure: null,
    result: "iVBORw0KGgoAAAANSUhEUgAA", revised_prompt: "A photorealistic casting photo.",
    saved_path: "/Users/k/.codex/generated_images/t/exec-ca00.png", transparent_background: false,
  },
};
const viewed = {
  type: "item.completed",
  item: { id: "exec-2571", type: "image_view", path: "/work/bible/aria/ref.png" },
};

describe("Codex pictures (feedback e780c2a2)", () => {
  it("reads a generated picture by its saved path and leaves the base64 out", () => {
    const read = readCodexEvent(generated);
    expect(read).toEqual({
      kind: "tool", id: "exec-ca00", name: "image_generation", state: "done",
      args: { file_path: "/Users/k/.codex/generated_images/t/exec-ca00.png", prompt: "A photorealistic casting photo." },
    });
    expect(JSON.stringify(read)).not.toContain("iVBORw0K");
  });

  it("reads a picture it looked at", () => {
    expect(readCodexEvent(viewed)).toEqual({
      kind: "tool", id: "exec-2571", name: "image_view", state: "done", args: { file_path: "/work/bible/aria/ref.png" },
    });
  });

  it("draws the picture once the call is done, and never folds it into a run", () => {
    const started = readCodexEvent({ ...generated, type: "item.started", item: { ...generated.item, status: "in_progress", saved_path: undefined } });
    expect(started && started.kind === "tool" && toolPicture(started.name, started.args, started.state)).toBeNull();
    expect(toolPicture("image_view", { file_path: "/a/b.png" }, "done")).toBe("/a/b.png");
    expect(toolPicture("image_view", { file_path: "/a/notes.txt" }, "done")).toBeNull();
    expect(toolPicture("Read", { file_path: "/a/b.png" }, "done")).toBeNull();

    const run = (id: string): Tool => ({ kind: "tool", id, name: "command_execution", argsJson: "", args: { command: "ls" }, state: "done" });
    const picture = { ...(readCodexEvent(viewed) as Tool), argsJson: "" } as Tool;
    const rows = groupRows([run("a"), picture, run("b")]);
    expect(rows.map((row) => row.kind)).toEqual(["group", "block", "group"]);
  });
});
