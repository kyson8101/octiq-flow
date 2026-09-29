// The memory line, as a chat draws it.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({
  knownPath: () => undefined,
  askPaths: () => {},
  subscribePaths: () => () => {},
}));

import type { Block, Message } from "../lib/chat";
import type { MemoryActivity } from "../lib/memoryActivity";
import { MessageList } from "./MessageList";
import { MemoryNote } from "./MemoryNote";

const activity: MemoryActivity = {
  id: "a".repeat(64),
  status: "saved",
  agent: { id: "agent_1", name: "Mango Juice" },
  at: 1_790_590_000_000,
  requestId: "r1",
  note: "agent-zone/agents/maya/memory.md",
  date: "2026-09-28",
  text: "Use the receipt, not prose.",
  receipt: { id: "a".repeat(64), status: "saved" },
};

const tool = (id: string): Block => ({
  kind: "tool", id, name: "Read", argsJson: "", args: { file_path: `/tmp/${id}.ts` }, result: "ok", state: "done",
});

const msg = (id: string, blocks: Block[]): Message => ({ id, role: "assistant", blocks, streaming: false });

describe("MemoryNote", () => {
  it("says who updated memory and when, with the words behind an accessible disclosure", () => {
    const html = renderToStaticMarkup(<MemoryNote activity={activity} />);
    expect(html).toContain("Mango Juice updated memory");
    expect(html).toMatch(/<time[^>]*dateTime="2026-09-2\dT/);
    const button = html.match(/<button[^>]*>/)![0];
    expect(button).toContain('aria-expanded="false"');
    const controls = button.match(/aria-controls="([^"]+)"/)![1];
    expect(html).toMatch(new RegExp(`<div id="${controls}" class="memory-note-details" hidden="">`));
    // The appended words, the note and the receipt — nothing else of the note.
    expect(html).toContain("Use the receipt, not prose.");
    expect(html).toContain("agent-zone/agents/maya/memory.md");
    expect(html).toContain("aaaaaaaaaaaa");
    expect(html).toContain('data-memory-status="saved"');
  });

  it("never draws a failure or a doubt as saved", () => {
    const failed = renderToStaticMarkup(
      <MemoryNote activity={{ ...activity, status: "failed", receipt: undefined, error: "Vault writes are off." }} />,
    );
    expect(failed).toContain("Mango Juice&#x27;s memory was not updated");
    expect(failed).not.toContain("updated memory<");
    expect(failed).toContain("Vault writes are off.");
    expect(failed).toContain('data-memory-status="failed"');
    const unsure = renderToStaticMarkup(
      <MemoryNote activity={{ ...activity, status: "uncertain", receipt: { id: activity.id, status: "needs_review" } }} />,
    );
    expect(unsure).toContain("memory update is unconfirmed");
    expect(unsure).toContain("needs review");
  });

  it("shows a refused call and the earlier save it met as two separate states", () => {
    const html = renderToStaticMarkup(
      <MemoryNote
        activity={{
          ...activity,
          id: "q".repeat(64),
          status: "refused",
          date: undefined,
          receipt: undefined,
          error: "This call was refused and wrote nothing.",
          earlier: { id: "a".repeat(64), status: "saved" },
        }}
      />,
    );
    expect(html).toContain('data-memory-status="refused"');
    expect(html).toContain("Mango Juice&#x27;s repeated memory request was refused");
    expect(html).not.toContain("not updated");
    // The earlier save's own state, visible without opening anything.
    expect(html).toMatch(/<div class="memory-note-earlier is-saved">[\s\S]*Earlier entry under this request is saved/);
    expect(html.indexOf("memory-note-earlier")).toBeLessThan(html.indexOf("memory-note-details"));
  });

  it("gives a coordinator a link to the worker chat instead of the words", () => {
    const html = renderToStaticMarkup(
      <MemoryNote
        activity={{
          ...activity,
          text: undefined,
          note: undefined,
          receipt: undefined,
          source: { chatKey: "chat:orch-worker-1", taskTitle: "Show memory updates" },
        }}
      />,
    );
    expect(html).toContain("Mango Juice updated memory");
    expect(html).toContain("Show memory updates");
    expect(html).toContain('href="#/c/orch-worker-1"');
    expect(html).not.toContain("<button");
  });

  it("stands on its own row in the turn, never folded in with the tool calls", () => {
    const html = renderToStaticMarkup(
      <MessageList
        busy={false}
        messages={[
          msg("m1", [tool("t1"), tool("t2"), tool("t3")]),
          msg("memory-1", [{ kind: "memory", activity }]),
          msg("m2", [tool("t4"), tool("t5"), { kind: "text", text: "Done." }]),
        ]}
      />,
    );
    const note = html.indexOf('class="memory-note');
    expect(note).toBeGreaterThan(0);
    // One turn: a single name over it, not a second one for the memory line.
    expect(html.match(/class="msg msg-assistant/g)).toHaveLength(1);
    expect(html.indexOf("Done.")).toBeGreaterThan(note);
  });

  it("takes no agent's name over a turn that is only a memory line", () => {
    const html = renderToStaticMarkup(
      <MessageList busy={false} messages={[msg("memory-1", [{ kind: "memory", activity }])]} hostName="Claude" />,
    );
    expect(html).not.toContain('class="msg-role"');
  });
});
