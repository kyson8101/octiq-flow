// Work that outlives the call that started it.
import { describe, expect, it } from "vitest";

import { backgroundCalls, backgroundSummary, taskLabel, type BackgroundTask } from "./background";
import { emptyChat, reduceChat } from "./chat";

const task = (over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: "t1",
  toolUseId: "toolu_1",
  label: "codex exec",
  kind: "local_bash",
  startedAt: 1000,
  ...over,
});

describe("taskLabel", () => {
  it("uses the caller's own description when there is one", () => {
    expect(taskLabel("local_bash", "Run the codex outline pass", "codex exec -m gpt-5")).toBe(
      "Run the codex outline pass",
    );
  });

  it("falls back to the program the command runs", () => {
    expect(taskLabel("local_bash", "", "CI=true codex exec --json")).toBe("codex");
  });

  it("names the kind when the event said nothing else", () => {
    expect(taskLabel("local_agent", "", "")).toBe("subagent");
    expect(taskLabel("local_workflow", "", "")).toBe("workflow");
    expect(taskLabel("local_bash", "", "")).toBe("background command");
  });
});

describe("backgroundCalls", () => {
  it("names the calls whose work is still running", () => {
    const calls = backgroundCalls([task(), task({ id: "t2", toolUseId: "toolu_2" })]);
    expect([...calls].sort()).toEqual(["toolu_1", "toolu_2"]);
  });

  it("skips work that never said which call started it", () => {
    expect(backgroundCalls([task({ toolUseId: undefined })]).size).toBe(0);
  });
});

describe("backgroundSummary", () => {
  it("says nothing when nothing is running", () => {
    expect(backgroundSummary([], 5000)).toBeNull();
  });

  it("counts them all and names the one that has waited longest", () => {
    const summary = backgroundSummary(
      [task({ id: "t2", label: "a subagent", startedAt: 4000 }), task({ startedAt: 1000 })],
      253_000,
    );
    expect(summary).toEqual({ count: 2, label: "codex exec", elapsedMs: 252_000 });
  });
});

describe("the roster, off the stream", () => {
  const started = (id: string, type: string) => ({
    type: "system",
    subtype: "task_started",
    task_id: id,
    tool_use_id: `toolu_${id}`,
    task_type: type,
    description: "Run codex",
    command: "codex exec",
  });

  it("puts a background command on the roster, where nothing else does", () => {
    const state = reduceChat(emptyChat(), started("b1", "local_bash"), 1000);
    expect(state.background.map((t) => t.id)).toEqual(["b1"]);
    // The rail is a list of AGENTS, and a shell command is not one.
    expect(state.agents).toEqual([]);
  });

  it("keeps the same start from a replay from doubling the row", () => {
    let state = reduceChat(emptyChat(), started("b1", "local_bash"), 1000);
    state = reduceChat(state, started("b1", "local_bash"), 1000);
    expect(state.background).toHaveLength(1);
  });

  it("keeps it running after the turn that started it has ended", () => {
    let state = reduceChat(emptyChat(), started("b1", "local_bash"), 1000);
    state = reduceChat(state, { type: "result", subtype: "success", result: "done" }, 2000);
    expect(state.busy).toBe(false);
    expect(state.background).toHaveLength(1);
  });

  it("takes it off when the work reports its ending", () => {
    let state = reduceChat(emptyChat(), started("b1", "local_bash"), 1000);
    state = reduceChat(
      state,
      { type: "system", subtype: "task_notification", task_id: "b1", status: "completed" },
      2000,
    );
    expect(state.background).toEqual([]);
  });

  it("takes it off when a patch says it is over, and not while it is still going", () => {
    let state = reduceChat(emptyChat(), started("b1", "local_bash"), 1000);
    state = reduceChat(
      state,
      { type: "system", subtype: "task_updated", task_id: "b1", patch: { status: "running" } },
      2000,
    );
    expect(state.background).toHaveLength(1);
    state = reduceChat(
      state,
      { type: "system", subtype: "task_updated", task_id: "b1", patch: { status: "failed" } },
      3000,
    );
    expect(state.background).toEqual([]);
  });

  it("lets go when the injected user turn is the word that it ended", () => {
    let state = reduceChat(emptyChat(), started("b1", "local_bash"), 1000);
    const notice = [
      "<task-notification>",
      "<task-id>b1</task-id>",
      "<status>completed</status>",
      "<summary>codex wrote the outline</summary>",
      "</task-notification>",
    ].join("\n");
    state = reduceChat(
      state,
      { type: "user", message: { role: "user", content: [{ type: "text", text: notice }] } },
      2000,
    );
    expect(state.background).toEqual([]);
  });

  it("keeps counting a Monitor, whose notice is news and not an ending", () => {
    let state = reduceChat(emptyChat(), started("b1", "local_bash"), 1000);
    const notice = [
      "<task-notification>",
      "<task-id>b1</task-id>",
      "<summary>still building</summary>",
      "</task-notification>",
    ].join("\n");
    state = reduceChat(
      state,
      { type: "user", message: { role: "user", content: [{ type: "text", text: notice }] } },
      2000,
    );
    expect(state.background).toHaveLength(1);
  });

  it("tracks a subagent too, which the rail shows but the strip has to count", () => {
    const state = reduceChat(emptyChat(), started("a1", "local_agent"), 1000);
    expect(state.background.map((t) => t.kind)).toEqual(["local_agent"]);
    expect(state.agents).toHaveLength(1);
  });
});
