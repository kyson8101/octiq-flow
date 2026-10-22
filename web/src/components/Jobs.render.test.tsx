// A job the agent registered with the host, where the page draws it: the line
// above the composer, the card that started it, and the turn that wakes the
// agent when it ends. Drawn through a store shaped like `lib/jobFeed`'s.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { BackgroundNote, JobCallsProvider, JobStoreProvider, type JobStore } from "./Background";
import { MessageList } from "./MessageList";
import { ToolCard } from "./ToolCard";
import { applyJobEvent, NO_JOBS, type Job, type JobsState } from "../lib/jobs";
import type { Message } from "../lib/chat";
import type { Tool } from "../lib/toolGroups";

const wire = (over: Partial<Job> = {}): Job => ({
  id: "job_1", chatKey: "chat:c1", label: "Render mp4", source: "wrapper", status: "running",
  elapsedMs: 65_000, sinceUpdateMs: 400, command: "npx remotion render Main out.mp4", wake: true, ...over,
});

const storeOf = (...jobs: Job[]): JobStore => {
  const now = Date.now();
  const state: JobsState = jobs.reduce((s, job) => applyJobEvent(s, { chatKey: job.chatKey, job }, now), NO_JOBS);
  return { snapshot: () => state, subscribe: () => () => {} };
};

const strip = (store: JobStore, busy = false) => renderToStaticMarkup(
  <JobStoreProvider value={store}>
    <BackgroundNote tasks={[]} chatKey="chat:c1" busy={busy}>Working</BackgroundNote>
  </JobStoreProvider>,
);

describe("the line above the composer", () => {
  it("says the job, its phase, and its own percent with a bar", () => {
    const html = strip(storeOf(wire({ phase: "Encoding", done: 120, total: 300, unit: "frames" })));
    expect(html).toContain("Render mp4");
    expect(html).toContain('<span class="job-phase">Encoding</span>');
    expect(html).toContain('style="width:40%"');
    expect(html).toContain('<span class="job-percent">40%</span>');
    expect(html).not.toContain("bgwork-time");
  });

  it("says how long it has run, and draws no bar, when the job gave no count", () => {
    const html = strip(storeOf(wire()));
    expect(html).not.toContain("job-meter");
    expect(html).toMatch(/<span class="bgwork-time">1m 0\ds<\/span>/);
  });

  it("is muted grey, with a still dot, once the job has gone quiet", () => {
    const html = strip(storeOf(wire({ sinceUpdateMs: 11 * 60_000, done: 1, total: 2 })));
    expect(html).toContain('class="bgwork-dot" data-stale="true"');
    expect(html).toContain('class="job-progress" data-stale="true"');
  });

  it("leaves the line as it was for a job that ended, and for another chat's", () => {
    expect(strip(storeOf(wire({ status: "failed", exitCode: 1 })))).toBe("Working");
    expect(strip(storeOf(wire({ chatKey: "chat:other" })))).toBe("Working");
  });

  it("adds no clock beside a turn's own while a turn runs", () => {
    const html = strip(storeOf(wire()), true);
    expect(html.startsWith("Working · ")).toBe(true);
    expect(html).not.toContain("bgwork-time");
    expect(html).not.toContain("bgwork-dot");
  });
});

describe("the card that started it", () => {
  const card = (state: Tool["state"] = "done") => ({
    kind: "tool", id: "t1", name: "Bash", argsJson: "{}", state,
    args: { command: "octiq-job --label 'Render mp4' -- npx remotion render Main out.mp4" },
  }) as Tool;
  const draw = (store: JobStore, calls: Map<string, string>) => renderToStaticMarkup(
    <JobStoreProvider value={store}>
      <JobCallsProvider value={calls}><ToolCard tool={card()} /></JobCallsProvider>
    </JobStoreProvider>,
  );

  it("says in background with the job's percent", () => {
    const html = draw(storeOf(wire({ done: 42, total: 100 })), new Map([["t1", "job_1"]]));
    expect(html).toContain("in background · 42%");
  });

  it("says in background alone with no count", () => {
    const html = draw(storeOf(wire()), new Map([["t1", "job_1"]]));
    expect(html).toContain("in background");
    expect(html).not.toContain("in background ·");
  });

  it("goes back to its own state once the job ended, or when it was matched to none", () => {
    expect(draw(storeOf(wire({ status: "done" })), new Map([["t1", "job_1"]]))).not.toContain("in background");
    expect(draw(storeOf(wire({ done: 42, total: 100 })), new Map())).not.toContain("in background");
  });
});

describe("the turn that wakes the agent", () => {
  const turn: Message = {
    id: "m1", turnId: "octiq-job-job_1", role: "user", streaming: false, delivery: "dispatched", echo: "e1",
    blocks: [{ kind: "text", text: '[OctiqFlow job ended] {"id":"job_1","label":"Render mp4","status":"done","exitCode":0}\nThe job "Render mp4" finished with exit code 0, after 2m 10s.\nCommand: npx remotion render Main out.mp4' }],
  };
  const draw = (store: JobStore, message: Message = turn) => renderToStaticMarkup(
    <JobStoreProvider value={store}>
      <MessageList messages={[message]} busy={false} onRestoreUnsent={() => {}} onCancelQueued={() => {}} onStartQueued={() => {}} />
    </JobStoreProvider>,
  );

  it("is named, not quoted, with the host's text behind a disclosure", () => {
    const html = draw(storeOf(wire({ status: "done", exitCode: 0 })));
    expect(html).toContain('<span class="wrap-up-note-label">Job finished</span>');
    expect(html).toContain('<span class="wrap-up-note-detail">Render mp4 · exit 0</span>');
    expect(html).toContain('data-mark="job"');
    expect(html).toContain("What the agent was told · 3 lines");
    expect(html).toMatch(/<details class="wrap-up-note-text">/);
    expect(html).toMatch(/<article class="msg msg-host [^"]*" aria-label="OctiqFlow job notification">/);
    expect(html).not.toContain("msg-user");
    expect(html).not.toContain("message-bubble");
    expect(html).not.toContain("message-delivery");
    expect(html).not.toContain('>Sent</span>');
    expect(html).not.toContain("data-map-turn");
    expect(html).not.toContain('class="msg-role"');
  });

  it("says a job that ended with no exit code as that, never exit null", () => {
    const html = draw(storeOf(wire({ status: "interrupted", exitCode: null })));
    expect(html).toContain('<span class="wrap-up-note-label">Job interrupted</span>');
    expect(html).toContain("Render mp4 · no exit code");
    expect(html).not.toContain("null");
  });

  it("says a failure in words", () => {
    const html = draw(storeOf(wire({ status: "failed", exitCode: 1 })));
    expect(html).toContain('<span class="wrap-up-note-label">Job failed</span>');
    expect(html).toContain("Render mp4 · exit 1");
  });

  it("is named from its own first line for a job the page does not hold", () => {
    const html = draw(storeOf());
    expect(html).toContain('<span class="wrap-up-note-label">Job finished</span>');
    expect(html).toContain('<span class="wrap-up-note-detail">Render mp4 · exit 0</span>');
  });

  it("is Job ended alone for a job the page does not hold and a turn with no line", () => {
    // The host's text before the line (933ced1), still on recorded chats.
    const older: Message = { ...turn, blocks: [{ kind: "text", text: "[OctiqFlow job ended]\nThe job \"Render mp4\" finished with exit code 0, after 2m 10s." }] };
    const html = draw(storeOf(), older);
    expect(html).toContain('<span class="wrap-up-note-label">Job ended</span>');
    expect(html).not.toContain("wrap-up-note-detail");
  });

  it("ignores a line that names another job", () => {
    const other: Message = { ...turn, turnId: "octiq-job-job_9" };
    const html = draw(storeOf(), other);
    expect(html).toContain('<span class="wrap-up-note-label">Job ended</span>');
    expect(html).not.toContain("wrap-up-note-detail");
  });

  it("is not a person's message: no copy, no restore, and a queued one is cancelled, not edited", () => {
    const delivered = draw(storeOf(wire({ status: "done", exitCode: 0 })));
    expect(delivered).not.toContain("Copy");
    const queued = draw(storeOf(), { ...turn, echo: undefined, delivery: "queued" });
    expect(queued).toContain("Cancel telling the agent the job ended");
    expect(queued).toContain('>×</button>');
    expect(queued).not.toContain("Send now");
    expect(queued).not.toContain("message-delivery");
    expect(queued).not.toContain(">Edit</button>");
    const failed = draw(storeOf(), { ...turn, echo: undefined, delivery: "failed" });
    expect(failed).not.toContain("Restore to composer");
    expect(failed).not.toContain("Cancel telling");
    expect(delivered).not.toContain("Cancel telling");
  });

  it("disables cancel while pending, preserves its error, and drops it on pickup or loss", () => {
    const queued = { ...turn, echo: undefined, delivery: "queued" as const };
    expect(draw(storeOf(), { ...queued, queueAction: "cancel" })).toMatch(/class="job-wake-cancel"[^>]*disabled/);
    expect(draw(storeOf(), { ...queued, queueError: "Could not cancel" })).toContain('role="alert">Could not cancel</p>');
    for (const extra of [{ echo: "e1" }, { takenUp: true }, { queueLost: true }]) {
      expect(draw(storeOf(), { ...queued, ...extra })).not.toContain("job-wake-cancel");
    }
  });

  it("keeps host wake-ups separate from the person's adjacent messages", () => {
    const messages: Message[] = [
      { ...turn, id: "u1", turnId: "person-1", blocks: [{ kind: "text", text: "Before the job" }] },
      turn,
      { ...turn, id: "u2", turnId: "person-2", blocks: [{ kind: "text", text: "After the job" }] },
    ];
    const html = renderToStaticMarkup(<MessageList messages={messages} busy={false} />);
    const articles = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/g)!;
    expect(articles).toHaveLength(3);
    expect(articles[0]).toContain("msg-user");
    expect(articles[0]).not.toContain("Job finished");
    expect(articles[1]).toContain("msg-host");
    expect(articles[1]).not.toContain("Before the job");
    expect(articles[1]).not.toContain("After the job");
    expect(articles[2]).toContain("msg-user");
  });
});
