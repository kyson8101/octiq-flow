// Whose failure a failed call was, as the page reads it.
//
// The host decides it (src-tauri/src/outcome.rs); these check that the page
// takes it from the three places the host puts it — a tool result's `_meta`,
// the host's own `octiq_tool_outcome` line, a provider event's
// `octiq_outcome` — and from nowhere else, and that the collapsed count says
// it without calling an expired card a failure.
import { describe, expect, it } from "vitest";

import { emptyChat, reduceChat, type ChatState } from "./chat";
import { groupLook } from "./toolGroups";
import { failureCounts, originCounts, outcomeBadge, readOutcome, type ToolOutcome } from "./toolOutcome";

const expired: ToolOutcome = { origin: "octiqflow", reasonClass: "approval-expired", severity: "warning" };
const denied: ToolOutcome = { origin: "octiqflow", reasonClass: "approval-denied", severity: "warning" };
const codexLimit: ToolOutcome = { origin: "provider", reasonClass: "rate-limit", providerName: "Codex", severity: "warning" };
const claudeError: ToolOutcome = { origin: "provider", reasonClass: "provider-error", providerName: "Claude", severity: "error" };

const tools = (state: ChatState) =>
  state.messages.flatMap((m) => m.blocks.filter((b) => b.kind === "tool"));

/** Claude asking for one tool, as its stream carries it. */
const toolUse = (id: string, name = "mcp__octiq__agent_update") => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input: { agent: "Nova" } }] },
});

/** Its answer, with the `tool_use_result` the CLI puts beside it. */
const toolResult = (id: string, isError: boolean, toolUseResult?: unknown) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "nothing was changed", is_error: isError }],
  },
  ...(toolUseResult === undefined ? {} : { tool_use_result: toolUseResult }),
});

describe("reading an outcome", () => {
  it("takes the host's shape and rejects anything else", () => {
    expect(readOutcome(expired)).toEqual(expired);
    expect(readOutcome({ origin: "provider", reasonClass: "rate-limit", providerName: "Codex", severity: "warning" })).toEqual(codexLimit);
    // A Codex item reaches the page snake_cased by the host.
    expect(readOutcome({ origin: "provider", reason_class: "rate-limit", provider_name: "Codex", severity: "warning" })).toEqual(codexLimit);
    expect(readOutcome({ origin: "somebody", reasonClass: "auth" })).toBeUndefined();
    expect(readOutcome("octiqflow")).toBeUndefined();
    expect(readOutcome(undefined)).toBeUndefined();
    // An unknown reason is still OctiqFlow's; an unknown severity is an error.
    expect(readOutcome({ origin: "octiqflow", reasonClass: "new-thing" })).toEqual({
      origin: "octiqflow",
      reasonClass: "other",
      severity: "error",
    });
  });

  it("badges a row with who and why", () => {
    expect(outcomeBadge(expired)).toBe("OctiqFlow · approval expired");
    expect(outcomeBadge(denied)).toBe("OctiqFlow · approval denied");
    expect(outcomeBadge(codexLimit)).toBe("Codex · rate limit");
    expect(outcomeBadge({ origin: "provider", reasonClass: "auth", providerName: "Claude", severity: "error" })).toBe("Claude · sign-in");
    expect(outcomeBadge({ origin: "octiqflow", reasonClass: "scope-refused", severity: "error" })).toBe("OctiqFlow · not allowed");
  });
});

describe("counting failures on the collapsed line", () => {
  const failed = (outcome?: ToolOutcome) => ({ state: "error", ...(outcome ? { outcome } : {}) });
  const texts = (list: { state: string; outcome?: ToolOutcome }[]) => failureCounts(list).map((f) => f.text);

  it("never calls an expired or declined card a failure", () => {
    expect(texts([...Array(7)].map(() => failed(expired)))).toEqual(["7 not answered (OctiqFlow)"]);
    expect(texts([failed(denied)])).toEqual(["1 denied (OctiqFlow)"]);
    expect(failureCounts([failed(expired)])[0].severity).toBe("warning");
  });

  it("says refused, timed out or failed for the host's errors", () => {
    expect(texts([
      failed({ origin: "octiqflow", reasonClass: "scope-refused", severity: "error" }),
      failed({ origin: "octiqflow", reasonClass: "validation", severity: "error" }),
    ])).toEqual(["2 refused (OctiqFlow)"]);
    expect(texts([failed({ origin: "octiqflow", reasonClass: "host-timeout", severity: "error" })])).toEqual(["1 timed out (OctiqFlow)"]);
    expect(texts([failed({ origin: "octiqflow", reasonClass: "other", severity: "error" })])).toEqual(["1 failed (OctiqFlow)"]);
  });

  it("names only the origin for the provider's, never which provider", () => {
    expect(texts([failed(codexLimit), failed(codexLimit)])).toEqual(["2 rate-limited (provider)"]);
    expect(texts([failed(claudeError)])).toEqual(["1 failed (provider)"]);
  });

  it("counts a call with no outcome exactly as before", () => {
    expect(texts([failed(), failed()])).toEqual(["2 failed"]);
    expect(failureCounts([failed()])[0].severity).toBe("error");
  });

  it("keeps each origin apart in a mixed run, in the order they appear", () => {
    expect(texts([
      { state: "done" },
      failed(expired),
      failed(codexLimit),
      failed(expired),
      failed(),
      { state: "running" },
    ])).toEqual(["2 not answered (OctiqFlow)", "1 rate-limited (provider)", "1 failed"]);
  });
});

describe("the phone's short form", () => {
  it("merges each origin into one count", () => {
    const failed = (outcome?: ToolOutcome) => ({ state: "error", ...(outcome ? { outcome } : {}) });
    const list = originCounts([
      failed(expired), failed(denied), failed(expired), failed(codexLimit), failed(claudeError), failed(), { state: "done" },
    ]);
    expect(list.map((f) => f.text)).toEqual(["3 OctiqFlow", "2 provider", "1 failed"]);
    expect(list.map((f) => f.severity)).toEqual(["warning", "error", "error"]);
  });
});

describe("the reducer takes the outcome from the host, not from the words", () => {
  it("reads a Claude MCP failure's outcome off tool_use_result._meta", () => {
    let state = reduceChat(emptyChat(), toolUse("toolu_1"));
    state = reduceChat(state, toolResult("toolu_1", true, { content: "Error: nope", _meta: { "octiq/outcome": expired } }));
    expect(tools(state)[0]).toMatchObject({ state: "error", outcome: expired });
  });

  it("leaves a failure with no outcome, and a success, without one", () => {
    let state = reduceChat(emptyChat(), toolUse("toolu_1", "Bash"));
    // The words say "approval", but words are never read.
    state = reduceChat(state, toolResult("toolu_1", true, "The person did not answer, approval expired"));
    expect(tools(state)[0].state).toBe("error");
    expect(tools(state)[0]).not.toHaveProperty("outcome");
    state = reduceChat(state, toolUse("toolu_2"));
    state = reduceChat(state, toolResult("toolu_2", false, { _meta: { "octiq/outcome": expired } }));
    expect(tools(state)[1].outcome).toBeUndefined();
  });

  it("puts the host's permission line on the call it was about", () => {
    let state = reduceChat(emptyChat(), toolUse("toolu_9", "Bash"));
    state = reduceChat(state, { type: "octiq_tool_outcome", tool_use_id: "toolu_9", octiq_outcome: denied });
    state = reduceChat(state, toolResult("toolu_9", true));
    expect(tools(state)[0]).toMatchObject({ state: "error", outcome: denied });
  });

  it("holds a line that arrives before its card, and never paints a success", () => {
    let state = reduceChat(emptyChat(), { type: "octiq_tool_outcome", tool_use_id: "toolu_5", octiq_outcome: expired });
    expect(state.messages).toHaveLength(0);
    state = reduceChat(state, toolUse("toolu_5", "Bash"));
    state = reduceChat(state, toolResult("toolu_5", true));
    expect(tools(state)[0].outcome).toEqual(expired);

    let ok = reduceChat(emptyChat(), toolUse("toolu_6", "Bash"));
    ok = reduceChat(ok, toolResult("toolu_6", false));
    ok = reduceChat(ok, { type: "octiq_tool_outcome", tool_use_id: "toolu_6", octiq_outcome: expired });
    expect(tools(ok)[0].outcome).toBeUndefined();
  });

  it("marks Claude's own refusal as the provider's", () => {
    const refused: ToolOutcome = { origin: "provider", reasonClass: "provider-error", providerName: "Claude", severity: "error" };
    let state = reduceChat(emptyChat(), toolUse("toolu_7", "Bash"));
    state = reduceChat(state, {
      type: "system", subtype: "permission_denied", tool_use_id: "toolu_7",
      decision_reason_type: "classifier", octiq_outcome: refused,
    });
    state = reduceChat(state, toolResult("toolu_7", true));
    expect(tools(state)[0].outcome).toEqual(refused);
  });

  it("reads a Codex MCP failure's snake_cased outcome and a Codex approval line", () => {
    let state = reduceChat(emptyChat(), {
      type: "item.completed",
      item: {
        id: "call_1", type: "mcp_tool_call", server: "octiq", tool: "agent_update", arguments: {},
        status: "failed",
        result: {
          content: [{ type: "text", text: "nothing was changed" }],
          _meta: { "octiq/outcome": { origin: "octiqflow", reason_class: "approval-expired", severity: "warning" } },
        },
      },
    });
    expect(tools(state)[0]).toMatchObject({ state: "error", outcome: expired });

    // A command Codex asked to run, refused on OctiqFlow's card by item id.
    state = reduceChat(state, {
      type: "item.started",
      item: { id: "cmd_1", type: "command_execution", command: "rm -rf build", status: "in_progress" },
    });
    state = reduceChat(state, { type: "octiq_tool_outcome", tool_use_id: "cmd_1", octiq_outcome: denied });
    state = reduceChat(state, {
      type: "item.completed",
      item: { id: "cmd_1", type: "command_execution", command: "rm -rf build", status: "failed", exit_code: 1 },
    });
    expect(tools(state)[1]).toMatchObject({ state: "error", outcome: denied });
  });

  it("puts a Codex stream failure's outcome on its Agent stream card", () => {
    const state = reduceChat(emptyChat(), {
      type: "error",
      message: "stream disconnected",
      error: { message: "stream disconnected", codex_error_info: "internalServerError" },
      octiq_outcome: { origin: "provider", reasonClass: "provider-error", providerName: "Codex", severity: "error" },
    });
    expect(tools(state)[0]).toMatchObject({
      name: "Agent stream",
      outcome: { origin: "provider", providerName: "Codex", reasonClass: "provider-error" },
    });
  });
});

describe("the General-chat report, replayed", () => {
  it("eight agent_update cards, seven unanswered: OctiqFlow's, never the provider's", () => {
    let state = emptyChat();
    const ids = [...Array(8)].map((_, i) => `toolu_${i}`);
    for (const id of ids) state = reduceChat(state, toolUse(id));
    state = reduceChat(state, toolResult(ids[0], false, { content: "saved" }));
    for (const id of ids.slice(1)) {
      state = reduceChat(state, toolResult(id, true, {
        content: "Error: The person did not answer within 180 seconds, so nothing was changed.",
        _meta: { "octiq/outcome": expired },
      }));
    }
    const calls = tools(state).filter((b) => b.kind === "tool");
    const look = groupLook(calls as Parameters<typeof groupLook>[0]);
    expect(look.success).toBe(1);
    expect(look.failed).toBe(7);
    expect(failureCounts(calls as { state: string; outcome?: ToolOutcome }[])).toEqual([
      { key: "octiqflow:not answered", count: 7, text: "7 not answered (OctiqFlow)", severity: "warning", origin: "octiqflow" },
    ]);
  });
});
