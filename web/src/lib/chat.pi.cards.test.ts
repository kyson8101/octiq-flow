import { describe, expect, it } from "vitest";

import { emptyChat, reduceChat, type ChatState, type Block } from "./chat";
import { EMPTY_ORCHESTRATION } from "./orchestration";
import { pendingActions } from "./pendingActions";
import { placeQuestions } from "./questionBlock";
import type { Question } from "./question";
import { foldable, type Tool } from "./toolGroups";

// The recorded Pi stream (scripts/test-pi-harness.mjs, real `pi --mode rpc`
// 1.5.2 against a fake Anthropic API), verbatim and never edited. What it
// recorded is a call the host's gate REFUSED (a `bash` the fake model asked
// for, answered `isError`) and an allowed `read`. The recorded stream holds no
// question and no approval card, because those are not stream events: a
// question is a call of OctiqFlow's `mcp__octiq__ask_user` that waits, and an
// approval is a card the host lists. So this test takes the recorded call's
// own events and gives that call the question tool's name and arguments (the
// shape Pi reports an MCP tool in, `mcp__<server>__<tool>`), and leaves it
// running, which is what a call that waits on the person looks like.
import turn from "./__fixtures__/pi-rpc-turn.jsonl?raw";

type Json = Record<string, unknown>;

const recorded = (): Json[] =>
  turn.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Json);

const ASK = "mcp__octiq__ask_user";
const ARGS = { questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }] };

/** The host's own adaptation, as `chat.pi.rpc.test` does it, reduced to what
 *  a transcript is made of. */
function transcript(): Json[] {
  const out: Json[] = [];
  for (const event of recorded()) {
    const message = event.message as Json | undefined;
    if (event.type === "response" || event.type === "extension_ui_request" || event.type === "turn_end") continue;
    if ((event.type === "message_start" || event.type === "message_end") && message?.role === "system") continue;
    out.push(event);
  }
  return out;
}

/** The first recorded tool call, up to its start, as a call to `ask_user`. */
function askingTurn(): Json[] {
  const events = transcript();
  const start = events.findIndex((e) => e.type === "tool_execution_start");
  expect(start).toBeGreaterThan(0);
  const id = events[start].toolCallId;
  return events.slice(0, start + 1).map((event) => {
    if (event.type === "tool_execution_start") return { ...event, toolName: ASK, args: ARGS };
    const message = event.message as Json | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return event;
    return {
      ...event,
      message: {
        ...message,
        content: content.map((part) =>
          (part as Json).type === "toolCall" && (part as Json).id === id
            ? { ...(part as Json), name: ASK, arguments: ARGS }
            : part,
        ),
      },
    };
  });
}

const prompt: Json = { type: "user", uuid: "turn-1", octiq_user_turn: true, message: { role: "user", content: [{ type: "text", text: "pick a store" }] } };
const replay = (events: Json[]): ChatState => events.reduce<ChatState>((state, event) => reduceChat(state, event), emptyChat());
const tools = (state: ChatState): Extract<Block, { kind: "tool" }>[] =>
  state.messages.flatMap((m) => m.blocks).filter((b): b is Extract<Block, { kind: "tool" }> => b.kind === "tool");

const question = (over: Partial<Question> = {}): Question => ({
  id: "q1", chatKey: "chat:pi", question: "Which database?", options: ["Postgres", "SQLite"], status: "pending", ...over,
});

describe("a Pi chat's ask_user, from the recorded stream", () => {
  it("draws the call as the question tool, still waiting, and keeps it out of a folded run", () => {
    const state = replay([prompt, ...askingTurn()]);
    const ask = tools(state).find((t) => t.name === ASK);
    expect(ask).toBeDefined();
    expect(ask!.state).toBe("running");
    expect(ask!.args).toEqual(ARGS);
    // Both ends of a Pi call carry its name; neither is turned into another.
    expect(tools(state).every((t) => t.name === ASK)).toBe(true);
    expect(foldable(ask as Tool)).toBe(false);
  });

  it("puts the host's pending question at that call, not at the end of the transcript", () => {
    const state = replay([prompt, ...askingTurn()]);
    const ask = tools(state).find((t) => t.name === ASK)!;
    const placed = placeQuestions(state.messages, [question()]);
    expect(placed.loose).toEqual([]);
    expect([...placed.byTool.keys()]).toEqual([ask.id]);
    expect(placed.byTool.get(ask.id)?.questions.map((q) => q.question)).toEqual(["Which database?"]);
  });

  it("leaves a question whose call is not in the transcript for the end of it", () => {
    const state = replay([prompt, ...askingTurn()]);
    const placed = placeQuestions(state.messages, [question({ question: "Something else?" })]);
    expect(placed.byTool.size).toBe(0);
    expect(placed.loose).toHaveLength(1);
  });
});

describe("a Pi chat's approval card", () => {
  it("is listed for the chat that owns it, like any other provider's", () => {
    const actions = pendingActions({
      orchestration: EMPTY_ORCHESTRATION,
      parents: new Map(),
      asks: { pi: [{ id: "p1" }] },
    });
    expect(actions.map((a) => [a.kind, a.chatId])).toEqual([["permission", "pi"]]);
  });

  it("draws a call the host's gate refused as an errored tool row the turn goes on from", () => {
    // The recorded refused `bash`: the host's gate answered deny, Pi reported
    // the call as an error with the host's reason, and the turn went on.
    const state = replay([prompt, ...transcript()]);
    const bash = tools(state).find((t) => t.name === "bash");
    expect(bash?.state).toBe("error");
    expect(JSON.stringify(bash?.result)).toContain("No shell here (fake host)");
    expect(state.busy).toBe(false);
    // The refused call is a tool row in error and nothing else: the one
    // failure this recording ends on is its fake API's own last request, not
    // the refusal (it comes after the turn's text and the allowed read).
    const refusedAt = state.messages.findIndex((m) => m.blocks.some((b) => b.kind === "tool" && b.name === "bash"));
    expect(refusedAt).toBeGreaterThan(-1);
  });
});
