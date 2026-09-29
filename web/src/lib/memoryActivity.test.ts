// The host's memory lines, folded by the chat reducer.
//
// The stream around them is a real capture (`__fixtures__/file-edits.jsonl`,
// verbatim `claude -p` output); only the `octiq_memory_activity` line is the
// host's, placed where the host writes it — while the tool call is pending,
// before its result comes back.
import { describe, expect, it } from "vitest";
import fileEdits from "./__fixtures__/file-edits.jsonl?raw";
import { emptyChat, reduceChat, type ChatState } from "./chat";
import { earlierState, mergeMemoryActivity, memoryHeadline, readMemoryActivity } from "./memoryActivity";

const saved = {
  type: "octiq_memory_activity",
  id: "r".repeat(64),
  status: "saved",
  agent: { id: "agent_1", name: "Mango Juice" },
  at: 1_790_590_000_000,
  requestId: "r1",
  note: "agent-zone/agents/maya/memory.md",
  date: "2026-09-28",
  text: "Use the receipt, not prose.",
  receipt: { id: "r".repeat(64), status: "saved" },
  error: null,
};

const fold = (events: unknown[], state: ChatState = emptyChat()) =>
  events.reduce<ChatState>((s, e) => reduceChat(s, e, 1), state);

const lines = (raw: string) => raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));

const memoryBlocks = (state: ChatState) =>
  state.messages.flatMap((m) => m.blocks.flatMap((b) => (b.kind === "memory" ? [b.activity] : [])));

describe("a memory line", () => {
  it("is drawn from the host's event, with who, when and exactly what was appended", () => {
    const state = fold([saved]);
    const [activity] = memoryBlocks(state);
    expect(activity).toMatchObject({
      status: "saved",
      agent: { name: "Mango Juice" },
      text: "Use the receipt, not prose.",
      note: "agent-zone/agents/maya/memory.md",
      receipt: { status: "saved" },
    });
    expect(memoryHeadline(activity)).toBe("Mango Juice updated memory");
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].streaming).toBe(false);
  });

  it("is one line however often it is replayed", () => {
    const state = fold([saved, saved, { ...saved }, saved]);
    expect(memoryBlocks(state)).toHaveLength(1);
  });

  it("moves only from uncertain to saved on the same receipt, never back", () => {
    const uncertain = { ...saved, status: "uncertain", receipt: { id: saved.id, status: "needs_review" }, error: "needs review" };
    let state = fold([uncertain]);
    expect(memoryHeadline(memoryBlocks(state)[0])).toBe("Mango Juice's memory update is unconfirmed");
    // "saved" about another receipt is not evidence about this one.
    state = fold([{ ...saved, receipt: { id: "x".repeat(64), status: "saved" } }], state);
    expect(memoryBlocks(state)[0].status).toBe("uncertain");
    state = fold([saved], state);
    expect(memoryBlocks(state)[0]).toMatchObject({ status: "saved", error: undefined });
    state = fold([{ ...saved, status: "failed" }, uncertain], state);
    expect(memoryBlocks(state)).toHaveLength(1);
    expect(memoryBlocks(state)[0].status).toBe("saved");
  });

  it("says a failure plainly and never names an agent it does not know", () => {
    const failed = readMemoryActivity({ ...saved, id: "f1", status: "failed", agent: null, receipt: null, error: "Only a registered agent's chat has an agent memory." })!;
    expect(memoryHeadline(failed)).toBe("Memory was not updated");
    expect(failed.agent).toBeUndefined();
    expect(failed.receipt).toBeUndefined();
    expect(memoryHeadline({ ...failed, agent: { id: "a", name: "Mango Juice" } })).toBe("Mango Juice's memory was not updated");
  });

  it("draws a call refused over an earlier save as two states, neither of them 'not updated'", () => {
    // The shape memory_activity.rs writes for a requestId that already belongs
    // to another, saved change: no receipt of its own, the earlier one's here.
    const refused = {
      ...saved,
      id: "q".repeat(64),
      status: "refused",
      date: null,
      text: "Something else.",
      receipt: null,
      error: "This call was refused and wrote nothing: requestId r1 already belongs to an earlier memory change.",
      earlier: { id: "r".repeat(64), status: "saved" },
    };
    const state = fold([saved, refused]);
    const [first, second] = memoryBlocks(state);
    expect(first.status).toBe("saved");
    expect(second).toMatchObject({ status: "refused", earlier: { id: "r".repeat(64), status: "saved" } });
    expect(second.receipt).toBeUndefined();
    expect(memoryHeadline(second)).toBe("Mango Juice's repeated memory request was refused");
    expect(memoryHeadline(second)).not.toMatch(/not updated/);
    expect(earlierState(second)).toBe("Earlier entry under this request is saved");
    expect(earlierState({ ...second, earlier: { id: "e", status: "needs_review" } })).toBe(
      "Earlier change under this request: needs review",
    );
    expect(earlierState(first)).toBeUndefined();
    // A refusal never moves the saved line, whichever arrives first.
    expect(mergeMemoryActivity(first, second)).toBe(first);
  });

  it("refuses an event with no id or an unknown status", () => {
    expect(readMemoryActivity({ ...saved, id: "" })).toBeNull();
    expect(readMemoryActivity({ ...saved, status: "pending" })).toBeNull();
    expect(fold([{ ...saved, status: "done" }]).messages).toHaveLength(0);
  });

  it("keeps the first report's snapshot when a later one differs", () => {
    const first = readMemoryActivity(saved)!;
    const later = readMemoryActivity({ ...saved, agent: { id: "b", name: "Potato Juice" }, text: "other" })!;
    expect(mergeMemoryActivity(first, later)).toBe(first);
  });

  it("lands inside a real turn, between a tool call and its result", () => {
    const stream = lines(fileEdits);
    const at = stream.findIndex((e) => JSON.stringify(e).includes('"tool_result"'));
    expect(at).toBeGreaterThan(0);
    const replay = [...stream.slice(0, at), saved, ...stream.slice(at)];
    const state = fold(replay);
    const plain = fold(stream);
    expect(memoryBlocks(state)).toHaveLength(1);
    // Everything the agent said is still there, in the same order.
    const text = (s: ChatState) => s.messages.flatMap((m) => m.blocks.flatMap((b) => (b.kind === "text" ? [b.text] : [])));
    expect(text(state)).toEqual(text(plain));
    const tools = (s: ChatState) => s.messages.flatMap((m) => m.blocks.flatMap((b) => (b.kind === "tool" ? [[b.id, b.state]] : [])));
    expect(tools(state)).toEqual(tools(plain));
    // Its own assistant message, after the call it came from.
    const index = state.messages.findIndex((m) => m.blocks.some((b) => b.kind === "memory"));
    expect(state.messages[index].role).toBe("assistant");
    expect(state.messages.slice(0, index).some((m) => m.blocks.some((b) => b.kind === "tool"))).toBe(true);
  });

  it("is not drawn for anything the agent merely says about its memory", () => {
    const state = fold([
      { type: "assistant", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "I've updated my memory." }] } },
      { type: "assistant", message: { id: "a2", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__octiq__vault_agent_memory_read", input: {} }] } },
    ]);
    expect(memoryBlocks(state)).toHaveLength(0);
  });
});
