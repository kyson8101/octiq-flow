import { describe, expect, it } from "vitest";

import { antigravityRefusal, emptyChat, reduceChat, type ChatState, type Message } from "./chat";
import { antigravityTool, readAntigravityEvent } from "./antigravityEvents";

// Real `agy` 1.2.16 streams, captured on 2026-10-03 with the flags
// `AntigravityProvider::build_command` uses (agent_provider.rs), verbatim. The
// Rust tests read the same files. Re-record them; never edit them.
import threeTurns from "./__fixtures__/antigravity-three-turns.jsonl?raw";
import planRefused from "./__fixtures__/antigravity-plan-refused.jsonl?raw";
import badModel from "./__fixtures__/antigravity-bad-model.jsonl?raw";
import interrupted from "./__fixtures__/antigravity-interrupted.jsonl?raw";

type Json = Record<string, unknown>;

const lines = (stream: string): Json[] =>
  stream.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Json);

/** What the host adds on the way through, as `agent_chat` does: the person's
 *  own turn before Antigravity takes it up, the turn id stamped on its
 *  `user_input` step, and on a refused `result` the access level that refused
 *  it (`mark_refusal_access`) and the provider's origin (`outcome::annotate`). */
function asTheHostRecordsIt(stream: string, access: string, prompts: string[]): Json[] {
  const out: Json[] = [];
  let turn = 0;
  for (const event of lines(stream)) {
    const step = event.step_update as Json | undefined;
    if (event.event === "step_update" && step?.step_type === "user_input") {
      const id = `turn-${turn}`;
      out.push({
        type: "user",
        uuid: id,
        octiq_user_turn: true,
        message: { role: "user", content: [{ type: "text", text: prompts[turn] ?? "" }] },
      });
      out.push({ ...event, octiq_user_turn_id: id });
      turn += 1;
      continue;
    }
    const result = event.result as Json | undefined;
    if (event.event === "result" && Array.isArray(result?.denied_actions) && result.denied_actions.length) {
      out.push({
        ...event,
        octiq_access: access,
        octiq_outcome: { origin: "provider", reasonClass: "provider-error", providerName: "Antigravity", severity: "error" },
      });
      continue;
    }
    out.push(event);
  }
  return out;
}

function fold(events: Json[], start: ChatState = emptyChat()): ChatState {
  return events.reduce<ChatState>((state, event) => reduceChat(state, event, 1000), start);
}

const tools = (messages: Message[]) =>
  messages.flatMap((m) => m.blocks.filter((b): b is Extract<typeof b, { kind: "tool" }> => b.kind === "tool"));

const said = (m: Message) =>
  m.blocks.filter((b): b is Extract<typeof b, { kind: "text" }> => b.kind === "text").map((b) => b.text).join("");

describe("Antigravity conversations (real agy 1.2.16 streams)", () => {
  it("answers, reads a file, is refused a command, and remembers across turns in one process", () => {
    const state = fold(
      asTheHostRecordsIt(threeTurns, "edits", [
        "Read notes.txt and tell me the launch code. Remember HERON.",
        "Run this shell command and report its output: git status",
        "Which word did I ask you to remember?",
      ]),
    );

    expect(state.sessionId).toBe("bb35e2e1-d2c3-4b8b-913d-7554783273ff");
    expect(state.busy).toBe(false);
    const users = state.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(3);
    expect(users.every((m) => m.takenUp)).toBe(true);

    const answers = state.messages.filter((m) => m.role === "assistant");
    expect(answers.every((m) => !m.streaming)).toBe(true);
    expect(said(answers[0])).toContain("4471");
    expect(said(answers.at(-1)!)).toBe("HERON\n");

    // Its file read and the refused command are tool rows, settled.
    const rows = tools(state.messages);
    const read = rows.find((b) => b.name === "view_file");
    expect(read).toMatchObject({ state: "done", result: "2 lines, 25 bytes" });
    expect(read?.args).toMatchObject({ AbsolutePath: expect.stringContaining("notes.txt") });
    // agy reported the refused command as a step that finished silently; the
    // turn's refusal is what says it was refused, so it is not ticked.
    expect(rows.find((b) => b.name === "run_command")).toMatchObject({
      state: "error",
      args: { CommandLine: "git status" },
      result: "Antigravity refused this call: nobody could approve it at this access level.",
      outcome: { origin: "provider", providerName: "Antigravity" },
    });
    // The file read before it, in an earlier turn, keeps its tick.
    expect(read?.state).toBe("done");

    // The refusal is said where the turn ended, with the level and the way on.
    const refusal = rows.find((b) => b.id.startsWith("agent-warning-"));
    expect(refusal?.result).toBe(
      "Antigravity refused a shell command at Accept edits access and ended the turn: it cannot ask anyone while it works, so no permission card can appear. Raise this chat's access to Auto or Skip permissions to let it run.",
    );
    expect(refusal?.outcome).toMatchObject({ origin: "provider", providerName: "Antigravity" });
    expect(state.failure).toBeUndefined();
  });

  it("counts each model call's tokens, not the conversation's running total", () => {
    const events = asTheHostRecordsIt(threeTurns, "edits", ["a"]);
    const firstTurnEnd = events.findIndex((e) => e.event === "result");
    const firstTurn = fold(events.slice(0, firstTurnEnd));
    const calls = events
      .slice(0, firstTurnEnd)
      .map((e) => (e.step_update as Json | undefined)?.usage as Json | undefined)
      .filter((u): u is Json => !!u);
    expect(calls).toHaveLength(2);
    expect(firstTurn.turnTokens).toBe(calls.reduce((sum, u) => sum + (u.output_tokens as number), 0));
    const last = calls.at(-1)!;
    expect(firstTurn.contextTokens).toBe((last.input_tokens as number) + (last.output_tokens as number));
  });

  it("shows a plan-mode refusal as a failed tool with the provider's words", () => {
    const state = fold(asTheHostRecordsIt(planRefused, "read", ["Create note.txt and run a command"]));
    const command = tools(state.messages).find((b) => b.name === "run_command");
    expect(command?.state).toBe("error");
    expect(command?.result).toContain("user denied permission to run command");
    const refusal = tools(state.messages).find((b) => b.id.startsWith("agent-warning-"));
    expect(refusal?.result).toContain("at Plan access");
  });

  it("says why a launch failed before any turn", () => {
    const state = fold(lines(badModel), { ...emptyChat(), busy: true });
    expect(state.busy).toBe(false);
    expect(state.failure?.detail).toContain("gemini-0-nonexistent is not recognized");
    expect(tools(state.messages).some((b) => b.id.startsWith("agent-error-") && b.state === "error")).toBe(true);
  });

  it("does not call the person's own stop a failure", () => {
    const state = fold(lines(interrupted), { ...emptyChat(), busy: true });
    expect(state.busy).toBe(false);
    expect(state.failure).toBeUndefined();
    expect(tools(state.messages)).toHaveLength(0);
  });
});

describe("readAntigravityEvent", () => {
  it("knows its lines by their own `event` field and nothing else's", () => {
    expect(readAntigravityEvent({ type: "result", result: "Claude's" })).toBeNull();
    expect(readAntigravityEvent({ type: "init", session_id: "x" })).toBeNull();
    expect(readAntigravityEvent({ event: "checkpoint" })).toBeNull();
    expect(readAntigravityEvent({ event: "init" })).toBeNull();
    expect(readAntigravityEvent({ event: "init", conversation_id: "c" })).toEqual({ kind: "session", id: "c" });
  });

  it("shows OctiqFlow's own tools under the names the page knows, however they were called", () => {
    expect(antigravityTool("mcp_octiqflow_octiq_ask_user", { questions: [] })).toEqual({
      name: "mcp__octiq__ask_user",
      args: { questions: [] },
    });
    expect(
      antigravityTool("call_mcp_tool", { ServerName: "octiqflow_octiq", ToolName: "task_status", Arguments: { objective: "x" } }),
    ).toEqual({ name: "mcp__octiq__task_status", args: { objective: "x" } });
    // Anyone else's server keeps exactly what Antigravity reported.
    const other = { ServerName: "probeplug_probe", ToolName: "probe_word", Arguments: {} };
    expect(antigravityTool("call_mcp_tool", other)).toEqual({ name: "call_mcp_tool", args: other });
    expect(antigravityTool("view_file", { AbsolutePath: "/a" })).toEqual({ name: "view_file", args: { AbsolutePath: "/a" } });
  });

  it("names both refusals, once each, and falls back when the level is unknown", () => {
    expect(antigravityRefusal(["mcp", "command", "mcp"], undefined)).toMatch(
      /^Antigravity refused an MCP tool call and a shell command at this access level and ended the turn/,
    );
  });
});
