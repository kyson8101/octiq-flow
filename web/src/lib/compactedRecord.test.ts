import { describe, expect, it } from "vitest";
import { emptyChat, reduceChat, type ChatState } from "./chat";
import commandEchoStream from "./__fixtures__/command-echo.jsonl?raw";
import fileEditsStream from "./__fixtures__/file-edits.jsonl?raw";
import modelSwitchStream from "./__fixtures__/model-switch.jsonl?raw";
import skillBundledLive from "./__fixtures__/skill-bundled-live.jsonl?raw";
import skillCallStream from "./__fixtures__/skill-call.jsonl?raw";
import taskStream from "./__fixtures__/task-subagent.jsonl?raw";
import workflowStream from "./__fixtures__/workflow.jsonl?raw";

type Event = Record<string, unknown>;

const FIELDS: Record<string, string> = {
  text_delta: "text",
  thinking_delta: "thinking",
  input_json_delta: "partial_json",
  signature_delta: "signature",
};

/** What `record_trim::compact_record` does to a record, written out again so
 *  a replay can be checked against it: once a message has stopped, the first
 *  stream piece of each of its blocks carries the block's whole text and the
 *  other pieces become `{"type":"octiq_compacted","into":<its seq>}`, in
 *  place, because a line's position is its seq. */
function compact(events: Event[]): Event[] {
  const writer = (e: Event) => `${String(e.parent_tool_use_id ?? "")}|${JSON.stringify(e.octiq_speaker ?? null)}`;
  const stream = (e: Event) => (e.type === "stream_event" ? (e.event as Event | undefined) : undefined);
  const stopped = new Set<string>();
  const current = new Map<string, string>();
  const blocks = new Map<string, { at: number[]; text: string; field: string; id: string }>();
  events.forEach((e, at) => {
    const inner = stream(e);
    if (inner?.type === "message_start") current.set(writer(e), String((inner.message as Event | undefined)?.id ?? ""));
    if (inner?.type === "message_stop" && current.has(writer(e))) stopped.add(current.get(writer(e))!);
    const delta = inner?.type === "content_block_delta" ? (inner.delta as Event) : undefined;
    const field = FIELDS[String(delta?.type)];
    const id = current.get(writer(e));
    if (!delta || !field || typeof delta[field] !== "string" || !id) return;
    const key = `${id}|${String(inner?.index ?? -1)}|${field}`;
    const block = blocks.get(key) ?? { at: [], text: "", field, id };
    block.at.push(at);
    block.text += delta[field] as string;
    blocks.set(key, block);
  });
  const out = [...events];
  for (const block of blocks.values()) {
    if (!stopped.has(block.id) || block.at.length < 2) continue;
    const [first, ...rest] = block.at;
    const event = structuredClone(out[first]) as Event;
    ((event.event as Event).delta as Event)[block.field] = block.text;
    out[first] = event;
    for (const at of rest) out[at] = { type: "octiq_compacted", into: first + 1 };
  }
  return out;
}

const replay = (events: Event[]) => events.reduce<ChatState>((state, e) => reduceChat(state, e, 0), emptyChat());
const lines = (raw: string) => raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event);

describe("a compacted record", () => {
  const streams = {
    "command-echo": commandEchoStream,
    "file-edits": fileEditsStream,
    "model-switch": modelSwitchStream,
    "skill-bundled-live": skillBundledLive,
    "skill-call": skillCallStream,
    "task-subagent": taskStream,
    workflow: workflowStream,
  };
  for (const [name, raw] of Object.entries(streams)) {
    it(`replays ${name} to the same conversation`, () => {
      const events = lines(raw);
      const compacted = compact(events);
      expect(compacted.filter((e) => e.type === "octiq_compacted").length).toBeGreaterThan(0);
      expect(replay(compacted)).toEqual(replay(events));
    });
  }

  it("keeps the pieces of a message that never finished", () => {
    const events = lines(taskStream);
    const stops = events.flatMap((e, at) => ((e.event as Event | undefined)?.type === "message_stop" ? [at] : []));
    const cut = stops[stops.length - 1];
    const unfinished = events.slice(0, cut);
    const compacted = compact(unfinished);
    expect(compacted.length).toBe(unfinished.length);
    expect(replay(compacted)).toEqual(replay(unfinished));
  });
});
