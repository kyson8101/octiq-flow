// Node-only offline evidence lives outside the browser-only src tsconfig.
// The optional evidence suite consumes the actual Rust compactor's output,
// never a second implementation of its edits. Run offline_storage_evidence
// first, then OCTIQ_RECORD_EVIDENCE=<scratch root> pnpm exec vitest run ... .
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { emptyChat, reduceChat, type ChatState } from "../src/lib/chat";
import { fileDiff } from "../src/lib/diff";
import { replayChat } from "../src/lib/replayChat";
import { CatchUp, type Frame } from "../src/lib/catchUp";

type Event = Record<string, any>;

async function* frames(path: string): AsyncGenerator<Frame> {
  const sources = new Map<string, { seq: number; value: unknown }>();
  let seq = 0;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let event: Event;
    try { event = JSON.parse(line); } catch { seq++; continue; }
    const count = event.type === "octiq_compacted" && Number.isInteger(event.count) && event.count > 0 && event.count <= 0xffffffff ? event.count : 1;
    seq += count;
    const group = event.type === "system" && ["init", "commands_changed"].includes(event.subtype) ? event.subtype : undefined;
    if (group) {
      const refs = event.octiq_record_refs ?? {};
      for (const [field, source] of Object.entries(refs)) {
        const material = sources.get(`${group}:${field}`);
        if (!material || material.seq !== source) throw new Error(`Missing list source ${field}:${source} in ${path}`);
        event[field] = material.value;
      }
      for (const field of ["tools", "slash_commands", "skills", "mcp_servers", "plugins", "commands"]) {
        if (field in event && !(field in refs)) sources.set(`${group}:${field}`, { seq, value: event[field] });
      }
      delete event.octiq_record_refs;
    }
    yield { seq, event };
  }
}

function drawn(state: ChatState) {
  return {
    ...state,
    messages: state.messages.map(message => ({
      ...message,
      blocks: message.blocks.map(block => {
        if (block.kind !== "tool") return block;
        const { details, ...card } = block;
        return { ...card, diff: fileDiff(block.name, block.args, details) };
      }),
    })),
  };
}

// serde_json's and V8's decimal parsers can differ by one ULP (captured
// Antigravity duration_seconds=3.35958). Only the adapter comparison rounds
// nonintegers; reducer output and every seq/integer still compare exactly.
function wireShape(value: any): any {
  if (typeof value === "number" && !Number.isInteger(value)) return Number(value.toPrecision(15));
  if (Array.isArray(value)) return value.map(wireShape);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wireShape(item)]));
  return value;
}

async function replay(path: string, batchReplay = false) {
  let state = emptyChat();
  const seqs: unknown[] = [];
  const facts: unknown[] = [];
  let last = 0;
  let batch: Frame[] = [];
  for await (const frame of frames(path)) {
    const e = frame.event as Event;
    last = frame.seq;
    if (e.type !== "octiq_compacted" && !(e.type === "stream_event" && e.event?.type === "content_block_delta")) {
      seqs.push([frame.seq, e.type, e.subtype, e.uuid, e.message?.id]);
    }
    if (e.type?.startsWith("octiq_") && e.type !== "octiq_compacted") facts.push(frame);
    if (batchReplay) {
      batch.push(frame);
      if (batch.length === 1000) { state = await replayChat(state, batch, 0, () => false); batch = []; }
    } else state = reduceChat(state, e, 0, "replay");
  }
  if (batch.length) state = await replayChat(state, batch, 0, () => false);
  return { drawn: drawn(state), seqs, facts, last };
}

it("catches up from inside a no-op range without shifting later events", () => {
  const catchUp = new CatchUp();
  catchUp.own("chat");
  catchUp.live("chat", 3, { type: "octiq_compacted", into: 2 });
  expect(catchUp.begin("chat")).toBe(3);
  const run = [{ seq: 20, event: { type: "octiq_compacted", into: 2, count: 18 } }, { seq: 21, event: { type: "result" } }];
  expect(catchUp.end("chat", run)).toEqual(run);
  expect(catchUp.mark("chat")).toBe(21);
});

const evidence = process.env.OCTIQ_RECORD_EVIDENCE;
const fixtures = evidence && existsSync(resolve(evidence, "fixtures")) ? readdirSync(resolve(evidence, "fixtures")).filter(name => name.endsWith(".jsonl")) : [];
describe.skipIf(!evidence)("Rust-compacted captured streams", () => {
  for (const name of fixtures) it(`draws ${name} identically through replayChat`, async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      const rust = readFileSync(resolve(evidence!, "decoded-fixtures", name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      const stored: Frame[] = [];
      for await (const frame of frames(resolve(evidence!, "fixtures", name))) stored.push(frame);
      expect(wireShape(stored)).toEqual(wireShape(rust));
      const original = await replay(resolve(import.meta.dirname, "../src/lib/__fixtures__", name), true);
      const compacted = await replay(resolve(evidence!, "fixtures", name), true);
      expect(compacted).toEqual(original);
    } finally { clock.mockRestore(); }
  }, 120_000);
});

const largeNames = (process.env.OCTIQ_RECORD_LARGE ?? "").split(",").filter(Boolean);
describe.skipIf(!evidence || !largeNames.length)("Rust-compacted large chat copies", () => {
  for (const name of largeNames) it(`draws ${name} identically with questions, tools and seq`, async () => {
    const original = await replay(resolve(evidence!, "original", name));
    const compacted = await replay(resolve(evidence!, "compacted", name));
    // Never print a private conversation in an assertion diff.
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    for (const key of ["drawn", "seqs", "facts", "last"] as const) {
      expect(digest(compacted[key]), key).toBe(digest(original[key]));
    }
  }, 3_600_000);
});
