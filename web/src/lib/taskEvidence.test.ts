import { describe, expect, it } from "vitest";
import { emptyChat, type Block, type ChatState, type Message } from "./chat";
import { readCodexEvent } from "./codexEvents";
import { deriveTaskEvidence } from "./taskEvidence";

const user = (id = "u1", text = "Fix the save button", accepted = true): Message => ({ id, role: "user", blocks: [{ kind: "text", text }], streaming: false, ...(accepted ? { echo: id } : {}) });
const tool = (name: string, args: unknown, rest: Partial<Extract<Block, { kind: "tool" }>> = {}): Extract<Block, { kind: "tool" }> => ({ kind: "tool", id: "t1", name, args, argsJson: JSON.stringify(args), state: "done", ...rest });
const assistant = (blocks: Block[], extra: Partial<Message> = {}): Message => ({ id: "a1", role: "assistant", streaming: false, blocks, ...extra });
const chat = (blocks: Block[], extra: Partial<ChatState> = {}): ChatState => ({ ...emptyChat(), messages: [user(), assistant(blocks)], ...extra });

describe("current task evidence", () => {
  it("does not call a crashed or unknown exit a finished turn", () => {
    expect(deriveTaskEvidence(chat([], { exited: { code: 1 } })).status).toBe("failed");
    expect(deriveTaskEvidence(chat([], { exited: { code: null } })).status).toBe("interrupted");
  });
  it("has no invented objective for an empty chat", () => {
    expect(deriveTaskEvidence(emptyChat())).toMatchObject({ status: "empty", files: [], checks: [], settled: false });
  });
  it("reconstructs Claude's latest recorded task list and active work", () => {
    const state = chat([tool("TodoWrite", { todos: [{ content: "Read code", status: "completed" }, { content: "Fix save", activeForm: "Fixing save", status: "in_progress" }] })], { busy: true });
    expect(deriveTaskEvidence(state)).toMatchObject({ objective: "Fix the save button", step: "Fixing save", progress: "1 of 2 recorded steps complete", status: "running" });
  });
  it("reads the Codex plan shape without inheriting a failed update", () => {
    const state = chat([tool("update_plan", { plan: [{ step: "Check behavior", status: "in_progress" }] }), tool("update_plan", { plan: [{ step: "Done", status: "completed" }] }, { id: "t2", state: "error" })], { busy: true });
    expect(deriveTaskEvidence(state).step).toBe("Check behavior");
  });
  it("does not let queued prompts overwrite the current objective", () => {
    const state = chat([tool("Write", { file_path: "first.ts" })], { busy: true });
    state.messages.push(user("u2", "Do something else", false));
    expect(deriveTaskEvidence(state).objective).toBe("Fix the save button");
  });
  it("starts accepted new tasks without the previous completion, files or pins", () => {
    const state = chat([tool("Edit", { file_path: "old.ts" }), tool("pin_file", { files: [{ path: "old.md" }] })]);
    state.messages.push({ ...user("u2", "New job", false), takenUp: true });
    state.busy = true;
    expect(deriveTaskEvidence(state)).toMatchObject({ objective: "New job", status: "running", files: [], pins: [], progress: undefined });
  });
  it("handles legacy replay without acceptance markers and ignores subagent task lists", () => {
    const state = { ...emptyChat(), messages: [user("u1", "Legacy task", false), assistant([{ kind: "text" as const, text: "Recorded response" }]), assistant([tool("TodoWrite", { todos: [{ content: "Other job", status: "completed" }] })], { parent: "subagent", id: "a2" })] };
    expect(deriveTaskEvidence(state)).toMatchObject({ objective: "Legacy task", status: "settled", progress: "Recorded response" });
  });
  it("distinguishes stop, interruption, failure, permission and connection uncertainty", () => {
    expect(deriveTaskEvidence(chat([], { stoppedAt: "a1" })).status).toBe("stopped");
    expect(deriveTaskEvidence(chat([]), { interrupted: true }).status).toBe("interrupted");
    expect(deriveTaskEvidence(chat([], { failure: { title: "Provider unavailable" } })).status).toBe("failed");
    expect(deriveTaskEvidence(chat([], { busy: true }), { blocker: "Approve command" })).toMatchObject({ status: "blocked", blocker: "Approve command" });
    expect(deriveTaskEvidence(chat([]), { connected: false })).toMatchObject({ status: "unknown", settled: false });
  });
  it("shows an addressed seat task and excludes unrelated host and seat activity", () => {
    const state = chat([tool("Write", { file_path: "host.ts" })]);
    state.messages.push({ ...user("u2", "Review the save flow", false), to: { id: "reviewer", name: "Reviewer" } });
    expect(deriveTaskEvidence(state)).toMatchObject({ objective: "Review the save flow", status: "waiting", files: [] });
    state.messages.push(assistant([tool("Read", { file_path: "save.ts" }, { state: "running" })], { id: "a2", streaming: true, speaker: { id: "reviewer", name: "Reviewer", agent: "codex" } }));
    state.messages.push(assistant([tool("Write", { file_path: "other.ts" })], { id: "a3", speaker: { id: "other", name: "Other", agent: "claude" } }));
    expect(deriveTaskEvidence(state)).toMatchObject({ objective: "Review the save flow", status: "running", files: [], step: "Read: save.ts" });
  });
  it("keeps the user's objective across synthetic relay and carry-on prompts", () => {
    const state = chat([tool("Edit", { file_path: "saved.ts" })]);
    state.messages.push({ ...user("u2", "Internal carry-on brief"), relay: "Carry on" }, assistant([{ kind: "text", text: "Continued" }], { id: "a2" }));
    expect(deriveTaskEvidence(state)).toMatchObject({ objective: "Fix the save button", files: ["saved.ts"], status: "settled" });
  });
  it("does not infer task success from a finished turn", () => {
    expect(deriveTaskEvidence(chat([{ kind: "text", text: "I could not finish" }])).status).toBe("settled");
  });
});

describe("delivery evidence", () => {
  it("records successful Claude edits and every Codex changed path only", () => {
    const read = readCodexEvent({ type: "item.completed", item: { type: "file_change", id: "c1", status: "completed", changes: [{ path: "one.ts" }, { path: "two.ts" }] } });
    if (!read || read.kind !== "tool") throw new Error("expected tool");
    const state = chat([tool("Write", { file_path: "new.ts" }), tool("Edit", { file_path: "failed.ts" }, { state: "error" }), tool("Edit", { file_path: "stopped.ts" }, { state: "stopped" }), tool("Bash", { command: "git diff" }, { result: "unrelated.ts" }), tool(read.name, read.args, { state: read.state })]);
    expect(deriveTaskEvidence(state).files).toEqual(["new.ts", "one.ts", "two.ts"]);
  });
  it("handles successful structured patches without scraping shell prose", () => {
    expect(deriveTaskEvidence(chat([tool("apply_patch", "*** Begin Patch\n*** Update File: web/a.ts\n*** Move to: web/b.ts\n*** End Patch")])).files).toEqual(["web/a.ts", "web/b.ts"]);
  });
  it("requires actual exit evidence even when tool and prose report completion", () => {
    const evidence = deriveTaskEvidence(chat([tool("Bash", { command: "npm test" }, { result: "All tests passed" })]));
    expect(evidence.checks[0].status).toBe("unknown");
  });
  it("keeps numeric Codex exit codes and never defaults a missing code to zero", () => {
    const read = (exit_code?: number) => readCodexEvent({ type: "item.completed", item: { type: "command_execution", id: "c1", status: "completed", command: "cargo test", aggregated_output: "test output", exit_code } });
    const result = read(1);
    if (!result || result.kind !== "tool") throw new Error("expected tool");
    expect(deriveTaskEvidence(chat([tool(result.name, result.args, { result: result.result, details: result.details })])).checks[0]).toMatchObject({ status: "failed", exitCode: 1 });
    expect(read()).not.toHaveProperty("details");
  });
  it("uses structured Claude results and explicit harness exit markers", () => {
    const evidence = deriveTaskEvidence(chat([tool("Bash", { command: "pnpm test" }, { details: { exitCode: 0 } }), tool("Bash", { command: "cargo check" }, { id: "t2", result: "Checking app\nProcess exited with code 0" })]));
    expect(evidence.checks.map((check) => check.status)).toEqual(["passed", "passed"]);
  });
  it("recognizes Codex shell wrappers", () => {
    expect(deriveTaskEvidence(chat([tool("Bash", { command: "/bin/zsh -lc 'cd web && npm test'" }, { details: { exit_code: 0 } })])).checks[0].status).toBe("passed");
  });
  it("recognizes project package checks and excludes quoted command descriptions", () => {
    const commands = ["pnpm exec tsc --noEmit", "pnpm --dir web test", "pnpm --dir 'my web' build", "cargo fmt --check", 'echo "example && npm test --all"'];
    const checks = deriveTaskEvidence(chat(commands.map((command, index) => tool("Bash", { command }, { id: String(index), details: { exit_code: 0 } })))).checks;
    expect(checks.map((check) => check.command)).toEqual(commands.slice(0, 4));
    expect(checks.every((check) => check.status === "passed")).toBe(true);
  });
  it("does not turn masked command exits or background starts green", () => {
    const evidence = deriveTaskEvidence(chat([tool("Bash", { command: "npm test || true" }, { details: { exit_code: 0 } }), tool("Bash", { command: "cargo test", run_in_background: true }, { id: "t2", finish: { taskId: "bg", status: "completed", summary: "Finished" } })]));
    expect(evidence.checks.map((check) => check.status)).toEqual(["unknown", "unknown"]);
  });
  it("excludes unrelated shell commands and preserves stopped or failed checks", () => {
    const evidence = deriveTaskEvidence(chat([tool("Bash", { command: "echo npm test" }), tool("Bash", { command: "npm install" }), tool("Bash", { command: "npm test" }, { state: "stopped" }), tool("Bash", { command: "cargo test" }, { id: "t2", state: "error" })]));
    expect(evidence.checks.map((check) => check.status)).toEqual(["stopped", "failed"]);
  });
  it("ignores failed pins and excludes all previous-turn delivery evidence", () => {
    const state = chat([tool("Bash", { command: "npm test" }, { details: { exit_code: 0 } })]);
    state.messages.push(user("u2", "Second task"), assistant([tool("pin_file", { files: [{ path: "new.md", why: "Read this" }] }), tool("pin_file", { files: [{ path: "failed.md" }] }, { state: "error" })], { id: "a2" }));
    expect(deriveTaskEvidence(state)).toMatchObject({ checks: [], pins: [{ path: "new.md", why: "Read this" }] });
  });
});
