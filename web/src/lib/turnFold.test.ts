import { describe, expect, it } from "vitest";
import { emptyChat, reduceChat, type Block, type Message } from "./chat";
import { terminalFailures, turnFold } from "./turnFold";
import claude from "./__fixtures__/file-edits.jsonl?raw";
import codex from "./__fixtures__/codex-seat.jsonl?raw";
import interrupted from "./__fixtures__/claude-interrupted-tool.jsonl?raw";
import { type Tool } from "./toolGroups";

const tool = (id: string, state: Tool["state"] = "done", name = "Bash"): Tool => ({
  kind: "tool", id, name, args: { command: "pnpm test" }, argsJson: "", state,
});
const text = (text: string): Block => ({ kind: "text", text });
const message = (blocks: Block[], extra: Partial<Message> = {}): Message => ({
  id: "a", role: "assistant", blocks, streaming: false, ...extra,
});
const replay = (stream: string) => stream.trim().split("\n").reduce((state, line) => reduceChat(state, JSON.parse(line)), emptyChat());
const visible = (messages: Message[], live = false) => {
  const fold = turnFold(messages, { live });
  return messages.flatMap((m) => m.blocks).filter((_, i) => !fold.hidden.has(i));
};

describe("a finished turn's work stretch", () => {
  it.each([["Claude", claude], ["Codex", codex]])("preserves the real %s stream's final reply", (_, stream) => {
    const state = replay(stream);
    const messages = state.messages.filter((m) => m.role === "assistant" && !m.parent);
    const fold = turnFold(messages, { live: false });
    expect(messages.at(-1)?.turnEnd?.status).toBe("completed");
    expect(fold.hidden.size).toBeGreaterThan(0);
    const lastText = messages.flatMap((m) => m.blocks).reverse().find((b) => b.kind === "text");
    expect(visible(messages)).toContain(lastText);
    expect(turnFold(messages, { live: true }).hidden.size).toBe(0);
  });

  it("retains a known Claude duration, with no guessed Codex duration", () => {
    expect(turnFold(replay(claude).messages.filter((m) => m.role === "assistant"), { live: false }).label).toContain("Worked 11s");
    expect(turnFold(replay(codex).messages.filter((m) => m.role === "assistant"), { live: false }).label).toMatch(/^Worked ·/);
  });

  it("counts calls, omits zero counts, and keeps the final message's text blocks", () => {
    const messages = [message([text("checking"), tool("1"), tool("2", "error"), tool("3", "done", "Read")]), message([text("Done"), text("Details")])];
    expect(turnFold(messages, { live: false }).label).toBe("Worked · 2 commands · 1 read");
    expect(visible(messages)).toEqual([text("Done"), text("Details")]);
  });

  it("folds earlier prose even without a tool between assistant messages", () => {
    const messages = [message([text("Checking")]), message([text("Answer")])];
    expect(visible(messages)).toEqual([text("Answer")]);
  });

  it.each(["failed", "stopped"] as const)("does not fold last prose when %s, or when the final message is empty", (status) => {
    const messages = [message([text("what I found"), tool("1", status === "stopped" ? "stopped" : "error")]), message([text("")], { turnEnd: { status } })];
    expect(visible(messages)).toContainEqual(text("what I found"));
  });

  it("keeps subagents, skills, stopped calls, questions, decisions, and host events outside", () => {
    const special: Block[] = [tool("task", "done", "Task"), tool("skill", "done", "Skill"), tool("stopped", "stopped"),
      tool("question", "done", "mcp__octiq__ask_user"), tool("access", "done", "mcp__octiq__request_access"),
      tool("route", "done", "mcp__octiq__route_chat"), { kind: "compacted", text: "history" }, { kind: "notice", text: "recovered" }];
    const messages = [message([tool("ordinary"), ...special, text("Done")])];
    expect(visible(messages)).toEqual([...special, text("Done")]);
    expect(turnFold(messages, { live: false, keepOut: () => true }).hidden.size).toBe(0);
  });

  it("keeps interrupted calls from a captured Claude stream", () => {
    const lines = interrupted.trim().split("\n");
    const firstEnd = lines.findIndex((line) => JSON.parse(line).type === "result");
    const state = replay(lines.slice(0, firstEnd + 1).join("\n"));
    const messages = state.messages.filter((m) => m.role === "assistant" && !m.parent);
    const calls = messages.flatMap((m) => m.blocks).filter((b) => b.kind === "tool");
    expect(messages.at(-1)?.turnEnd?.status).toBe("stopped");
    expect(calls).toHaveLength(1);
    expect(visible(messages)).toContain(calls[0]);
  });
});

describe("recovered failures", () => {
  it("quiets a failure followed by a later call or prose, across messages", () => {
    expect(terminalFailures([tool("1", "error"), tool("2")], true, false).size).toBe(0);
    expect(terminalFailures([tool("1", "error"), text("I will retry")], true, false).size).toBe(0);
  });
  it("only keeps a terminal failure red once the turn ends", () => {
    expect([...terminalFailures([tool("1", "error")], true, false)]).toEqual(["1"]);
    expect(terminalFailures([tool("1", "error")], false, false).size).toBe(0);
  });
  it("keeps failures red when the turn itself failed", () => {
    expect([...terminalFailures([tool("1", "error"), tool("2"), text("Partial")], true, true)]).toEqual(["1"]);
  });
});

it("quiets a Codex error followed only by commentary, preserving its order", () => {
  let state = emptyChat();
  for (const event of [
    { type: "turn.started" },
    { type: "item.completed", item: { id: "tool", type: "command_execution", command: "/bin/zsh -lc 'pnpm test'", exit_code: 1, status: "failed", aggregated_output: "failed" } },
    { type: "item.completed", item: { id: "note", type: "agent_message", phase: "commentary", text: "I checked the failure." } },
    { type: "turn.completed", usage: {} },
  ]) state = reduceChat(state, event);
  const messages = state.messages.filter((m) => m.role === "assistant");
  expect(messages[0].textAfterTool).toBeTruthy();
  expect(turnFold(messages, { live: false }).danger.size).toBe(0);
  expect(turnFold(messages.map((m) => ({ ...m, turnEnd: { status: "failed" } })), { live: false }).danger.size).toBe(1);
});

it.each(["completed", "failed", "stopped"] as const)("keeps the newest progress prose when the %s turn has no final text", (status) => {
  const fold = turnFold([message([tool("1")], { progress: ["Checking", "Latest finding"], turnEnd: { status } })], { live: false });
  expect(fold.lastProgress).toBe("Latest finding");
  expect(fold.hasProgressWork).toBe(true);
});
